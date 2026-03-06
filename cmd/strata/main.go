package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/strata-iac/strata/internal/app"
	"github.com/strata-iac/strata/internal/auth"
	"github.com/strata-iac/strata/internal/checkpoints"
	"github.com/strata-iac/strata/internal/config"
	"github.com/strata-iac/strata/internal/crypto"
	"github.com/strata-iac/strata/internal/db"
	"github.com/strata-iac/strata/internal/events"
	httpserver "github.com/strata-iac/strata/internal/http"
	"github.com/strata-iac/strata/internal/http/handlers"
	"github.com/strata-iac/strata/internal/http/middleware"
	"github.com/strata-iac/strata/internal/stacks"
	"github.com/strata-iac/strata/internal/storage/blobs"
	"github.com/strata-iac/strata/internal/updates"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	dbPool, err := db.Connect(cfg)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}

	if err := db.RunMigrations(context.Background(), dbPool); err != nil {
		logger.Error("failed to run database migrations", "error", err)
		os.Exit(1)
	}

	blobStore, err := blobs.New(context.Background(), cfg)
	if err != nil {
		logger.Error("failed to initialize blob store", "error", err)
		os.Exit(1)
	}

	if cfg.AuthMode != "dev" {
		logger.Error("unsupported auth mode for current phase", "auth_mode", cfg.AuthMode)
		os.Exit(1)
	}

	authenticator := auth.NewDevAuthenticator(cfg)
	stacksService := stacks.NewPostgresService(dbPool)
	updatesService := updates.NewPostgresService(dbPool)
	checkpointsService := checkpoints.NewNopService()
	eventsService := events.NewNopService()
	cryptoService := crypto.NewNopService()
	stackHandler := handlers.NewStackHandler(stacksService)
	updateHandler := handlers.NewUpdateHandler(updatesService)

	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.Logging(logger))
	router.Use(middleware.Recovery(logger))
	router.Use(middleware.Gzip)
	router.Use(middleware.CORS)
	router.Use(middleware.PulumiAccept)
	router.Get("/healthz", handlers.Healthz)
	router.Get("/api/capabilities", handlers.Capabilities)

	// Protected routes (require auth)
	router.Group(func(r chi.Router) {
		r.Use(middleware.Auth(authenticator))
		r.Get("/api/user", handlers.NewUserHandler())
		r.Get("/api/user/stacks", stackHandler.ListStacks)
		r.Head("/api/stacks/{org}/{project}", stackHandler.ProjectExists)
		r.Post("/api/stacks/{org}/{project}", stackHandler.CreateStack)
		r.Get("/api/stacks/{org}/{project}/{stack}", stackHandler.GetStack)
		r.Delete("/api/stacks/{org}/{project}/{stack}", stackHandler.DeleteStack)
		r.Post("/api/stacks/{org}/{project}/{stack}/rename", stackHandler.RenameStack)
		r.Post("/api/stacks/{org}/{project}/{stack}/update", updateHandler.CreateUpdateFor("update"))
		r.Post("/api/stacks/{org}/{project}/{stack}/preview", updateHandler.CreateUpdateFor("preview"))
		r.Post("/api/stacks/{org}/{project}/{stack}/refresh", updateHandler.CreateUpdateFor("refresh"))
		r.Post("/api/stacks/{org}/{project}/{stack}/destroy", updateHandler.CreateUpdateFor("destroy"))
		r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}", updateHandler.StartUpdate)
	})

	router.Group(func(r chi.Router) {
		r.Use(middleware.PulumiAccept)
		r.Use(middleware.UpdateAuth(updatesService))
		r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpoint", updateHandler.PatchCheckpoint)
		r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpointverbatim", updateHandler.PatchCheckpointVerbatim)
		r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/events/batch", updateHandler.RecordEvents)
		r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/renew_lease", updateHandler.RenewLease)
		r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/complete", updateHandler.CompleteUpdate)
	})

	srv := httpserver.NewServer(cfg.ListenAddr, router, logger)
	application := app.New(cfg, logger, dbPool, app.Services{
		Authenticator: authenticator,
		Stacks:        stacksService,
		Updates:       updatesService,
		Checkpoints:   checkpointsService,
		Events:        eventsService,
		Crypto:        cryptoService,
		BlobStore:     blobStore,
	}, srv)

	if err := application.Start(context.Background()); err != nil {
		logger.Error("failed to start application", "error", err)
		os.Exit(1)
	}

	logger.Info("strata started", "listen_addr", cfg.ListenAddr)

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		logger.Info("received shutdown signal", "signal", sig.String())
	case err := <-srv.Err():
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server exited with error", "error", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := application.Stop(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}

	logger.Info("strata stopped")
}
