// Package web provides the embedded SPA static assets.
package web

import "embed"

// DistFS contains the built React application assets.
// Run "npm run build" in the web/ directory before building the Go binary.
//
//go:embed dist/*
var DistFS embed.FS
