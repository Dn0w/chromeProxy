//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
)

func installPlatform(manifestPath string) {
	keys := []string{
		`SOFTWARE\Google\Chrome\NativeMessagingHosts\` + hostName,
		`SOFTWARE\Chromium\NativeMessagingHosts\` + hostName,
		`SOFTWARE\Microsoft\Edge\NativeMessagingHosts\` + hostName,
	}
	for _, keyPath := range keys {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.SET_VALUE)
		if err != nil {
			fmt.Println("  Warning:", keyPath, "-", err)
			continue
		}
		if err := k.SetStringValue("", manifestPath); err != nil {
			fmt.Println("  Warning:", keyPath, "-", err)
		} else {
			fmt.Println(" ", keyPath)
		}
		k.Close()
	}
}

func uninstallPlatform() {
	keys := []string{
		`SOFTWARE\Google\Chrome\NativeMessagingHosts\` + hostName,
		`SOFTWARE\Chromium\NativeMessagingHosts\` + hostName,
		`SOFTWARE\Microsoft\Edge\NativeMessagingHosts\` + hostName,
	}
	for _, keyPath := range keys {
		if err := registry.DeleteKey(registry.CURRENT_USER, keyPath); err != nil {
			fmt.Println("  Warning:", keyPath, "-", err)
		} else {
			fmt.Println("  Removed registry:", keyPath)
		}
	}
}
