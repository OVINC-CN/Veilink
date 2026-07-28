package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OVINC-CN/Veilink/apps/server/internal/config"
)

func TestStaticServesPreferredPrecompressedAsset(t *testing.T) {
	root := t.TempDir()
	original := []byte("const message = 'the original javascript response';")
	writeStaticTestFile(t, filepath.Join(root, "index.html"), []byte("<main>index</main>"))
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js"), original)
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js.br"), []byte("brotli-response"))
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js.gz"), []byte("gzip-response"))
	handler := staticTestHandler(root)

	request := httptest.NewRequest(http.MethodGet, "/assets/app-ABC123.js", nil)
	request.Header.Set("Accept-Encoding", "gzip, br")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if body := response.Body.String(); body != "brotli-response" {
		t.Fatalf("expected Brotli sidecar, got %q", body)
	}
	if encoding := response.Header().Get("Content-Encoding"); encoding != "br" {
		t.Fatalf("expected br content encoding, got %q", encoding)
	}
	if contentType := response.Header().Get("Content-Type"); !strings.Contains(contentType, "javascript") {
		t.Fatalf("expected JavaScript content type, got %q", contentType)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("unexpected cache control: %q", cacheControl)
	}
	if pragma := response.Header().Get("Pragma"); pragma != "" {
		t.Fatalf("expected Pragma to be removed, got %q", pragma)
	}
	if expires := response.Header().Get("Expires"); expires != "" {
		t.Fatalf("expected Expires to be removed, got %q", expires)
	}
	if !headerContainsToken(response.Header().Values("Vary"), "Accept-Encoding") {
		t.Fatalf("expected Vary: Accept-Encoding, got %q", response.Header().Values("Vary"))
	}
}

func TestStaticFallsBackAcrossEncodingsAndRanges(t *testing.T) {
	root := t.TempDir()
	original := []byte("0123456789-original-response")
	writeStaticTestFile(t, filepath.Join(root, "index.html"), []byte("<main>index</main>"))
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js"), original)
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js.br"), []byte("brotli-response"))
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js.gz"), []byte("gzip-response"))
	handler := staticTestHandler(root)

	t.Run("disabled Brotli uses gzip", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/assets/app-ABC123.js", nil)
		request.Header.Set("Accept-Encoding", "br;q=0, gzip")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", response.Code)
		}
		if body := response.Body.String(); body != "gzip-response" {
			t.Fatalf("expected gzip sidecar, got %q", body)
		}
		if encoding := response.Header().Get("Content-Encoding"); encoding != "gzip" {
			t.Fatalf("expected gzip content encoding, got %q", encoding)
		}
	})

	t.Run("range uses original representation", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/assets/app-ABC123.js", nil)
		request.Header.Set("Accept-Encoding", "br, gzip")
		request.Header.Set("Range", "bytes=0-7")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusPartialContent {
			t.Fatalf("expected status 206, got %d", response.Code)
		}
		if body := response.Body.String(); body != string(original[:8]) {
			t.Fatalf("expected original byte range, got %q", body)
		}
		if encoding := response.Header().Get("Content-Encoding"); encoding != "" {
			t.Fatalf("expected identity content encoding, got %q", encoding)
		}
		if contentRange := response.Header().Get("Content-Range"); contentRange != "bytes 0-7/28" {
			t.Fatalf("unexpected content range: %q", contentRange)
		}
	})
}

func TestStaticKeepsSPAFallbackAndReservedRoutesUncached(t *testing.T) {
	root := t.TempDir()
	writeStaticTestFile(t, filepath.Join(root, "index.html"), []byte("<main>original index</main>"))
	writeStaticTestFile(t, filepath.Join(root, "index.html.br"), []byte("brotli-index"))
	handler := staticTestHandler(root)

	t.Run("SPA fallback", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/rooms/example", nil)
		request.Header.Set("Accept", "text/html")
		request.Header.Set("Accept-Encoding", "br")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", response.Code)
		}
		if body := response.Body.String(); body != "brotli-index" {
			t.Fatalf("expected compressed index fallback, got %q", body)
		}
		if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store, max-age=0" {
			t.Fatalf("unexpected cache control: %q", cacheControl)
		}
		if pragma := response.Header().Get("Pragma"); pragma != "no-cache" {
			t.Fatalf("expected no-cache pragma, got %q", pragma)
		}
		if expires := response.Header().Get("Expires"); expires != "0" {
			t.Fatalf("expected immediate expiry, got %q", expires)
		}
	})

	for _, path := range []string{"/api/unknown", "/signal"} {
		t.Run(path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))

			if response.Code != http.StatusNotFound {
				t.Fatalf("expected status 404, got %d", response.Code)
			}
			if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store, max-age=0" {
				t.Fatalf("unexpected cache control: %q", cacheControl)
			}
		})
	}
}

func TestStaticRejectsEscapingSymlinksWithoutSPAFallback(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeStaticTestFile(t, filepath.Join(root, "index.html"), []byte("<main>index fallback</main>"))
	writeStaticTestFile(t, filepath.Join(outside, "secret.js"), []byte("outside secret"))
	if err := os.Symlink(outside, filepath.Join(root, "escaped")); err != nil {
		t.Fatalf("create escaping symlink: %v", err)
	}
	handler := staticTestHandler(root)

	request := httptest.NewRequest(http.MethodGet, "/escaped/secret.js", nil)
	request.Header.Set("Accept", "text/html")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", response.Code)
	}
	if body := response.Body.String(); strings.Contains(body, "outside secret") || strings.Contains(body, "index fallback") {
		t.Fatalf("unsafe path unexpectedly served content: %q", body)
	}
}

func TestStaticRejectsEscapingPrecompressedSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeStaticTestFile(t, filepath.Join(root, "index.html"), []byte("<main>index</main>"))
	writeStaticTestFile(t, filepath.Join(root, "assets", "app-ABC123.js"), []byte("original"))
	writeStaticTestFile(t, filepath.Join(outside, "secret.br"), []byte("outside secret"))
	if err := os.Symlink(
		filepath.Join(outside, "secret.br"),
		filepath.Join(root, "assets", "app-ABC123.js.br"),
	); err != nil {
		t.Fatalf("create escaping sidecar symlink: %v", err)
	}
	handler := staticTestHandler(root)

	request := httptest.NewRequest(http.MethodGet, "/assets/app-ABC123.js", nil)
	request.Header.Set("Accept-Encoding", "br")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", response.Code)
	}
	if body := response.Body.String(); strings.Contains(body, "outside secret") {
		t.Fatalf("unsafe sidecar unexpectedly served content: %q", body)
	}
}

func staticTestHandler(root string) http.Handler {
	server := &Server{
		cfg:         config.Config{StaticRoot: root},
		staticIndex: filepath.Join(root, "index.html"),
		staticReady: true,
	}
	return server.securityHeaders(http.HandlerFunc(server.static))
}

func writeStaticTestFile(t *testing.T, path string, contents []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create static test directory: %v", err)
	}
	if err := os.WriteFile(path, contents, 0o644); err != nil {
		t.Fatalf("write static test file: %v", err)
	}
}

func headerContainsToken(values []string, wanted string) bool {
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(item), wanted) {
				return true
			}
		}
	}
	return false
}
