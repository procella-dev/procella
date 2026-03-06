// Package spa serves a single-page application from an embedded filesystem.
// It serves static files when they exist and falls back to index.html for
// client-side routing support.
package spa

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Handler returns an http.Handler that serves an SPA from the given filesystem.
// Static files (JS, CSS, images) are served directly. All other paths fall back
// to index.html so that client-side routing works correctly.
func Handler(root fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(root))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip API routes — they're handled by other handlers.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		// Clean the path and try to open the file.
		p := path.Clean(r.URL.Path)
		if p == "/" {
			p = "index.html"
		} else {
			p = strings.TrimPrefix(p, "/")
		}

		// Check if the file exists in the embedded FS.
		f, err := root.Open(p)
		if err == nil {
			_ = f.Close()
			// File exists — serve it directly.
			fileServer.ServeHTTP(w, r)
			return
		}

		// File doesn't exist — serve index.html for SPA routing.
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
