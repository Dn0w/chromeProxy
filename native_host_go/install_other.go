//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func installPlatform(manifestPath string) {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		fmt.Println("  Warning: could not read manifest:", err)
		return
	}
	for _, d := range nmDirs() {
		if err := os.MkdirAll(d, 0o755); err != nil {
			fmt.Println("  Warning: could not create", d)
			continue
		}
		p := filepath.Join(d, hostName+".json")
		if err := os.WriteFile(p, data, 0o644); err != nil {
			fmt.Println("  Warning:", err)
		} else {
			fmt.Println(" ", p)
		}
	}
}

func uninstallPlatform() {
	for _, d := range nmDirs() {
		p := filepath.Join(d, hostName+".json")
		if err := os.Remove(p); err == nil {
			fmt.Println("  Removed:", p)
		}
	}
}
