package main

import (
	"context"
	"crypto/tls"
	"errors"
	"go/version"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/OVINC-CN/Veilink/apps/server/internal/config"
	"github.com/OVINC-CN/Veilink/apps/server/internal/server"
	"github.com/OVINC-CN/Veilink/apps/server/internal/store"
)

func main() {
	if version.Compare(runtime.Version(), "go1.26.5") < 0 {
		log.Fatalf("unsupported Go runtime %s: Veilink requires Go 1.26.5 or newer", runtime.Version())
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	state, err := store.New(cfg)
	if err != nil {
		log.Fatalf("state initialization failed: %v", err)
	}
	connectCtx, connectCancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := state.Connect(connectCtx); err != nil {
		connectCancel()
		log.Fatalf("state connection failed: %v", err)
	}
	connectCancel()
	defer state.Close()

	application := server.New(cfg, state)
	httpServer := &http.Server{
		Addr:              server.Address(cfg),
		Handler:           application.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       75 * time.Second,
		MaxHeaderBytes:    16 * 1024,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS13},
	}

	serveErrors := make(chan error, 1)
	go func() {
		if cfg.TLSCertFile != "" {
			serveErrors <- httpServer.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile)
			return
		}
		serveErrors <- httpServer.ListenAndServe()
	}()

	log.Printf("Veilink signaling server listening on %s", httpServer.Addr)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-stop:
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP server stopped unexpectedly: %v", err)
		}
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = httpServer.Shutdown(shutdownCtx)
	_ = application.Close(shutdownCtx)
}
