// Command ai-agent is the entry point for the AI Console per-machine agent.
//
// The library at ai-console-agent/internal/agent contains the actual state
// machine (enroll, WS reconnect, task worker, journal, upgrade). This binary
// is a thin CLI wrapper:
//
//   ai-agent [--server URL] [--token TOKEN] [--enroll-only] [--version]
//
// Flags mirror the installer contract (agent/install.sh) so the two stay in
// lockstep. `--enroll-only` performs a one-shot enroll and exits; the systemd
// unit / launchd plist runs the binary without --enroll-only so it enters the
// long-running Run loop and reconnects the WebSocket forever.
//
// Version is injected via -ldflags "-X main.version=vX.Y.Z" at build time
// (see agent/build-dist.sh). Runtime callers get it through Config.Version
// which flows into enroll / heartbeat and lets the Console record which
// version each machine is on.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	agentlib "ai-console-agent/internal/agent"
)

// version is populated by the build system via -ldflags. Default "dev" means
// running out of a `go build` without ldflags — useful for local iteration.
// ponytail (BUG-06): the historical build-dist.sh already referenced this
// symbol via `-X main.version=...`. Without a main package the linker used to
// fail silently in some Go versions and produce a binary with version "dev"
// — the agent then reported the wrong version to the console, which shipped
// self-upgrade decisions from bogus data.
var version = "dev"

func main() {
	server := flag.String("server", os.Getenv("SERVER"), "console base URL (e.g. https://console.example.com)")
	token := flag.String("token", os.Getenv("TOKEN"), "one-time enroll token (only needed on first run)")
	enrollOnly := flag.Bool("enroll-only", false, "enroll and exit (used by installers)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *server == "" && *token == "" {
		// No server + no token: we can only run if a prior enrollment saved
		// state.json. New() + Run() will attempt to load; if nothing's there
		// the error path fires below.
	}

	// ponytail (BUG-06): SIGINT/SIGTERM cancels the run context so long-lived
	// WebSocket loops shut down cleanly. systemd sends SIGTERM on stop; launchd
	// sends SIGTERM before SIGKILL. Without signal.NotifyContext the WS reader
	// goroutine would leak until process exit.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := agentlib.New(&agentlib.Config{
		Server:  *server,
		Token:   *token,
		Version: version,
	})
	if err != nil {
		fatal(err)
	}

	if *enrollOnly {
		if err := a.Enroll(ctx); err != nil {
			fatal(err)
		}
		fmt.Fprintf(os.Stderr, "enrolled: server_id=%s\n", a.ServerID())
		return
	}

	if err := a.Run(ctx); err != nil && err != context.Canceled {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "ai-agent: %v\n", err)
	os.Exit(1)
}
