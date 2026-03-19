package main

import (
	"bufio"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ── CA lifecycle ──────────────────────────────────────────────────────────────

var (
	caKey      *rsa.PrivateKey
	caCert     *x509.Certificate
	caCertPEM  []byte
	certCache  sync.Map // hostname → tls.Certificate
)

func loadOrCreateCA(dir string) error {
	keyPath  := filepath.Join(dir, "ca.key")
	certPath := filepath.Join(dir, "ca.crt")

	// Try loading existing CA from disk
	keyBytes, errK  := os.ReadFile(keyPath)
	certBytes, errC := os.ReadFile(certPath)
	if errK == nil && errC == nil {
		keyBlock, _  := pem.Decode(keyBytes)
		certBlock, _ := pem.Decode(certBytes)
		if keyBlock != nil && certBlock != nil {
			key, err1  := x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
			cert, err2 := x509.ParseCertificate(certBlock.Bytes)
			if err1 == nil && err2 == nil {
				caKey     = key
				caCert    = cert
				caCertPEM = certBytes
				return nil
			}
		}
	}

	// Generate new 2048-bit CA key
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			CommonName:   "Chrome Proxy CA",
			Organization: []string{"Chrome Proxy"},
		},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return err
	}

	keyPEM  := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	os.MkdirAll(dir, 0o755)
	os.WriteFile(keyPath,  keyPEM,  0o600)
	os.WriteFile(certPath, certPEM, 0o644)

	caKey     = key
	caCert    = cert
	caCertPEM = certPEM
	return nil
}

// ── Per-host certificate generation ──────────────────────────────────────────

func certForHost(hostname string) (tls.Certificate, error) {
	if v, ok := certCache.Load(hostname); ok {
		return v.(tls.Certificate), nil
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: hostname},
		DNSNames:     []string{hostname},
		NotBefore:    time.Now().Add(-24 * time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM  := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, err
	}

	certCache.Store(hostname, tlsCert)
	return tlsCert, nil
}

// ── MITM handler ──────────────────────────────────────────────────────────────

func (p *ProxyServer) handleMITM(clientConn net.Conn, targetConn net.Conn, hostname, port, srcHost, srcPort string) {
	tlsCert, err := certForHost(hostname)
	if err != nil {
		p.sendLog("CONNECT", srcHost, srcPort, hostname, port, "", "error", "mitm")
		return
	}

	// Wrap the client side in TLS — present our fake cert
	clientTLS := tls.Server(clientConn, &tls.Config{
		Certificates: []tls.Certificate{tlsCert},
		NextProtos:   []string{"http/1.1"}, // force HTTP/1.1 so we can parse
	})
	defer clientTLS.Close()

	// Wrap the target side in TLS — real connection to the server
	targetTLS := tls.Client(targetConn, &tls.Config{
		ServerName: hostname,
	})
	defer targetTLS.Close()

	if err := targetTLS.Handshake(); err != nil {
		p.sendLog("CONNECT", srcHost, srcPort, hostname, port, "", "error", "mitm")
		return
	}

	p.sendLog("CONNECT", srcHost, srcPort, hostname, port, "", "mitm", "mitm")

	clientReader := bufio.NewReader(clientTLS)
	targetReader := bufio.NewReader(targetTLS)

	for {
		req, err := http.ReadRequest(clientReader)
		if err != nil {
			break
		}

		// Apply stealth to the decrypted inner request
		req.Header.Del("Proxy-Connection")
		req.Header.Del("Proxy-Authorization")
		for h := range stealthStrip {
			req.Header.Del(h)
		}
		req.Header.Set("User-Agent", chromeUA)

		uri := req.URL.RequestURI()
		req.RequestURI = uri

		if err := req.Write(targetTLS); err != nil {
			break
		}

		resp, err := http.ReadResponse(targetReader, req)
		if err != nil {
			break
		}

		p.sendLog(req.Method, srcHost, srcPort, hostname, port, uri, fmt.Sprintf("%d", resp.StatusCode), "mitm")

		shouldClose := resp.Close
		resp.Write(clientTLS)
		resp.Body.Close()

		if shouldClose {
			break
		}
	}
}
