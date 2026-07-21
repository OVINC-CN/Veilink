package main

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	port := 3000
	if configured, err := strconv.Atoi(os.Getenv("PORT")); err == nil && configured > 0 && configured <= 65535 {
		port = configured
	}
	scheme := "http"
	client := http.DefaultClient
	if os.Getenv("TLS_CERT_FILE") != "" {
		scheme = "https"
		client = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
			// This is an in-container loopback probe; certificate identity is enforced
			// for user traffic by the server and external client.
			InsecureSkipVerify: true, //nolint:gosec
		}}}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(port))+"/healthz", nil)
	if err != nil {
		os.Exit(1)
	}
	response, err := client.Do(request)
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
