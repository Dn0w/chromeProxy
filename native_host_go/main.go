// chrome-proxy native messaging host
// Implements an HTTP/HTTPS proxy server controlled via Chrome native messaging.
//
// Run modes:
//   chrome-proxy-*           — native messaging host (stdin/stdout JSON)
//   chrome-proxy-* --install <extension-id>  — install native messaging manifest
//   chrome-proxy-* --uninstall               — remove manifest and binary
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// installPlatform and uninstallPlatform are defined in install_windows.go
// and install_other.go via build tags.

// ── Install / uninstall ───────────────────────────────────────────────────────

const hostName = "com.chromeproxy.host"

func installDir() string {
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local, _ = os.UserHomeDir()
		}
		return filepath.Join(local, "ChromeProxy")
	default:
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".local", "share", "chrome-proxy")
	}
}

func nmDirs() []string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		return []string{
			filepath.Join(base, "Google", "Chrome", "NativeMessagingHosts"),
			filepath.Join(base, "Chromium", "NativeMessagingHosts"),
			filepath.Join(base, "Microsoft Edge", "NativeMessagingHosts"),
		}
	case "windows":
		return nil // Windows uses registry
	default:
		return []string{
			filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts"),
			filepath.Join(home, ".config", "chromium", "NativeMessagingHosts"),
		}
	}
}

type nmManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func doInstall(extID string) {
	dir := installDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "Error creating install dir:", err)
		os.Exit(1)
	}

	// Copy self to install dir
	exe, _ := os.Executable()
	dstName := "chrome-proxy"
	if runtime.GOOS == "windows" {
		dstName += ".exe"
	}
	dst := filepath.Join(dir, dstName)

	src, err := os.Open(exe)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot open self:", err)
		os.Exit(1)
	}
	defer src.Close()

	// Write to a temp file first, then rename — avoids "text file busy" when
	// the binary is already installed and running.
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot write binary:", err)
		os.Exit(1)
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		os.Remove(tmp)
		fmt.Fprintln(os.Stderr, "Copy failed:", err)
		os.Exit(1)
	}
	out.Close()
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		fmt.Fprintln(os.Stderr, "Rename failed:", err)
		os.Exit(1)
	}

	hostPath := dst

	// On Windows also write a .bat wrapper
	if runtime.GOOS == "windows" {
		bat := filepath.Join(dir, "chrome-proxy.bat")
		content := "@echo off\r\n\"" + dst + "\" %*\r\n"
		if err := os.WriteFile(bat, []byte(content), 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "Cannot write bat:", err)
			os.Exit(1)
		}
		hostPath = bat
	}

	manifest := nmManifest{
		Name:           hostName,
		Description:    "Chrome Proxy Native Host",
		Path:           hostPath,
		Type:           "stdio",
		AllowedOrigins: []string{"chrome-extension://" + extID + "/"},
	}
	data, _ := json.MarshalIndent(manifest, "", "  ")

	// Write manifest JSON to install dir
	mp := filepath.Join(dir, hostName+".json")
	if err := os.WriteFile(mp, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot write manifest:", err)
		os.Exit(1)
	}

	// Register with browsers (platform-specific)
	installPlatform(mp)

	fmt.Println()
	fmt.Println("  Binary  :", dst)
	fmt.Println("  Ext ID  :", extID)
	fmt.Println()
	fmt.Println("  Done! Return to the extension and click Start Proxy.")
	fmt.Println()
}

func doUninstall() {
	dir := installDir()
	uninstallPlatform()
	// Remove binary
	bin := filepath.Join(dir, "chrome-proxy")
	if runtime.GOOS == "windows" {
		os.Remove(filepath.Join(dir, "chrome-proxy.bat"))
		bin += ".exe"
	}
	os.Remove(bin)
	fmt.Println("  Removed:", bin)
	fmt.Println()
	fmt.Println("  Uninstall complete.")
}

// ── Native messaging ──────────────────────────────────────────────────────────

type InMsg struct {
	Command  string `json:"command"`
	Port     int    `json:"port"`
	BindAddr string `json:"bindAddr"`
	Mode     string `json:"mode"` // "normal" | "stealth" | "mitm"
}

// StatusMsg is sent in response to start/stop/getStatus commands.
type StatusMsg struct {
	Type     string `json:"type"`
	Running  bool   `json:"running"`
	Port     int    `json:"port"`
	BindAddr string `json:"bindAddr"`
	Mode     string `json:"mode"`
	CAReady  bool   `json:"caReady"`
	CAPEM    string `json:"caPEM,omitempty"`
	Error    string `json:"error,omitempty"`
}

// LogMsg is sent for each proxied request.
type LogMsg struct {
	Type    string `json:"type"`
	Method  string `json:"method"`
	SrcHost string `json:"src_host"`
	SrcPort string `json:"src_port"`
	Host    string `json:"host"`
	Port    string `json:"port"`
	Path    string `json:"path"`
	Status  string `json:"status"`
	Mode    string `json:"mode"` // "normal" | "stealth" | "mitm"
	Time    string `json:"timestamp"`
}

func readMsg() (*InMsg, error) {
	var size uint32
	if err := binary.Read(os.Stdin, binary.LittleEndian, &size); err != nil {
		return nil, err
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(os.Stdin, buf); err != nil {
		return nil, err
	}
	var msg InMsg
	if err := json.Unmarshal(buf, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

var writeMu sync.Mutex

func sendMsg(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	size := uint32(len(data))
	_ = binary.Write(os.Stdout, binary.LittleEndian, size)
	_, _ = os.Stdout.Write(data)
}

// ── Stealth ───────────────────────────────────────────────────────────────────

var stealthStrip = map[string]bool{
	"via":                 true,
	"x-forwarded-for":     true,
	"x-forwarded-proto":   true,
	"x-forwarded-host":    true,
	"forwarded":           true,
	"x-real-ip":           true,
	"proxy-connection":    true,
	"proxy-authorization": true,
	"proxy-authenticate":  true,
	"x-proxy-id":          true,
}

const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// ── Proxy server ──────────────────────────────────────────────────────────────

type ProxyServer struct {
	mu       sync.Mutex
	listener net.Listener
	running  bool
	port     int
	bindAddr string
	mode     string // "normal" | "stealth" | "mitm"
}

var proxy = &ProxyServer{port: 8080, bindAddr: "0.0.0.0", mode: "normal"}

func (p *ProxyServer) start(port int, bindAddr, mode string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if mode == "" {
		mode = "normal"
	}

	if p.running && p.listener != nil {
		if p.port == port && p.bindAddr == bindAddr && p.mode == mode {
			return nil
		}
		// If only mode changed, update in-place — no listener restart needed.
		// Mode is read per-connection so new value takes effect immediately.
		if p.port == port && p.bindAddr == bindAddr {
			p.mode = mode
			return nil
		}
		p.listener.Close()
		p.running = false
	}

	if port <= 0 {
		port = p.port
	}
	if bindAddr == "" {
		bindAddr = p.bindAddr
	}

	addr := fmt.Sprintf("%s:%d", bindAddr, port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	p.listener = ln
	p.port = port
	p.bindAddr = bindAddr
	p.mode = mode
	p.running = true

	go p.serve(ln)
	return nil
}

func (p *ProxyServer) stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.listener != nil {
		p.listener.Close()
		p.listener = nil
	}
	p.running = false
}

func (p *ProxyServer) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go p.handleConn(conn)
	}
}

func (p *ProxyServer) handleConn(conn net.Conn) {
	defer conn.Close()
	srcAddr := conn.RemoteAddr().(*net.TCPAddr)
	srcHost := srcAddr.IP.String()
	srcPort := fmt.Sprintf("%d", srcAddr.Port)

	reader := bufio.NewReader(conn)
	req, err := http.ReadRequest(reader)
	if err != nil {
		return
	}

	p.mu.Lock()
	mode := p.mode
	p.mu.Unlock()

	if req.Method == "CONNECT" {
		p.handleConnect(conn, req, mode, srcHost, srcPort)
	} else {
		p.handleHTTP(conn, req, mode, srcHost, srcPort)
	}
}

func (p *ProxyServer) handleConnect(conn net.Conn, req *http.Request, mode, srcHost, srcPort string) {
	host := req.Host
	if !strings.Contains(host, ":") {
		host += ":443"
	}

	target, err := net.DialTimeout("tcp", host, 15*time.Second)
	if err != nil {
		fmt.Fprintf(conn, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		p.sendLog("CONNECT", srcHost, srcPort, req.Host, portOf(host), "", "error", mode)
		return
	}
	defer target.Close()

	fmt.Fprintf(conn, "HTTP/1.1 200 Connection established\r\n\r\n")

	hostname, port, _ := net.SplitHostPort(host)

	// MITM mode: TLS interception (requires CA)
	if mode == "mitm" && caKey != nil {
		p.handleMITM(conn, target, hostname, port, srcHost, srcPort)
		return
	}

	// Stealth mode: blind tunnel but labelled — headers can't be stripped (encrypted)
	// Normal mode: plain blind tunnel
	status := "tunneling"
	if mode == "stealth" {
		status = "stealth"
	} else if mode == "mitm" {
		status = "tunneling" // mitm requested but CA not ready — fall back to normal tunnel
	}
	p.sendLog("CONNECT", srcHost, srcPort, hostname, port, "", status, mode)

	done := make(chan struct{}, 2)
	go func() { io.Copy(target, conn); done <- struct{}{} }()
	go func() { io.Copy(conn, target); done <- struct{}{} }()
	<-done
}

func (p *ProxyServer) handleHTTP(conn net.Conn, req *http.Request, mode, srcHost, srcPort string) {
	req.Header.Del("Proxy-Connection")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Te")
	req.Header.Del("Trailers")
	req.Header.Del("Transfer-Encoding")
	req.Header.Del("Upgrade")

	if mode == "stealth" || mode == "mitm" {
		for h := range stealthStrip {
			req.Header.Del(h)
		}
		req.Header.Set("User-Agent", chromeUA)
	}

	targetHost := req.Host
	if !strings.Contains(targetHost, ":") {
		targetHost += ":80"
	}

	target, err := net.DialTimeout("tcp", targetHost, 15*time.Second)
	if err != nil {
		fmt.Fprintf(conn, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		p.sendLog(req.Method, srcHost, srcPort, req.Host, portOf(targetHost), req.URL.RequestURI(), "error", mode)
		return
	}
	defer target.Close()

	req.RequestURI = req.URL.RequestURI()
	req.Header.Set("Connection", "close")
	if err := req.Write(target); err != nil {
		p.sendLog(req.Method, srcHost, srcPort, req.Host, portOf(targetHost), req.URL.RequestURI(), "error", mode)
		return
	}

	resp, err := http.ReadResponse(bufio.NewReader(target), req)
	if err != nil {
		p.sendLog(req.Method, srcHost, srcPort, req.Host, portOf(targetHost), req.URL.RequestURI(), "error", mode)
		return
	}
	defer resp.Body.Close()

	status := fmt.Sprintf("%d", resp.StatusCode)
	p.sendLog(req.Method, srcHost, srcPort, req.Host, portOf(targetHost), req.URL.RequestURI(), status, mode)

	resp.Write(conn)
}

func (p *ProxyServer) sendLog(method, srcHost, srcPort, host, hostPort, path, status, mode string) {
	sendMsg(LogMsg{
		Type:    "log",
		Method:  method,
		SrcHost: srcHost,
		SrcPort: srcPort,
		Host:    host,
		Port:    hostPort,
		Path:    path,
		Status:  status,
		Mode:    mode,
		Time:    time.Now().Format("15:04:05"),
	})
}

func portOf(hostport string) string {
	_, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return ""
	}
	return port
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	log.SetOutput(io.Discard)

	args := os.Args[1:]
	if len(args) >= 1 {
		switch args[0] {
		case "--install":
			extID := ""
			if len(args) >= 2 {
				extID = args[1]
			}
			if extID == "" {
				fmt.Fprintln(os.Stderr, "Usage: chrome-proxy --install <extension-id>")
				os.Exit(1)
			}
			doInstall(extID)
			return
		case "--uninstall":
			doUninstall()
			return
		}
	}

	// Native messaging host mode — init CA before entering message loop
	loadOrCreateCA(installDir())

	for {
		msg, err := readMsg()
		if err != nil {
			return
		}

		switch msg.Command {
		case "start":
			if err := proxy.start(msg.Port, msg.BindAddr, msg.Mode); err != nil {
				proxy.mu.Lock()
				proxy.running = false
				proxy.mu.Unlock()
				sendMsg(StatusMsg{Type: "status", CAReady: caKey != nil, CAPEM: string(caCertPEM), Error: err.Error()})
			} else {
				proxy.mu.Lock()
				sendMsg(StatusMsg{
					Type:     "status",
					Running:  true,
					Port:     proxy.port,
					BindAddr: proxy.bindAddr,
					Mode:     proxy.mode,
					CAReady:  caKey != nil,
					CAPEM:    string(caCertPEM),
				})
				proxy.mu.Unlock()
			}

		case "stop":
			proxy.stop()
			sendMsg(StatusMsg{Type: "status", CAReady: caKey != nil, CAPEM: string(caCertPEM)})

		case "getStatus":
			proxy.mu.Lock()
			sendMsg(StatusMsg{
				Type:     "status",
				Running:  proxy.running,
				Port:     proxy.port,
				BindAddr: proxy.bindAddr,
				Mode:     proxy.mode,
				CAReady:  caKey != nil,
				CAPEM:    string(caCertPEM),
			})
			proxy.mu.Unlock()
		}
	}
}
