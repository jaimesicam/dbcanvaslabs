package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// terminal.go — bridges a browser WebSocket to a real interactive shell inside a node
// container, via Docker's raw exec hijack (docker.go's HijackExec). Mirrors
// ~/Projects/dbcanvas's own terminal.go (read-only reference): binary frames carry raw
// pty bytes both ways; text frames carry a resize message.

func handleTerminal(docker *Docker, nodeID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.CloseNow()

		ctx := r.Context()
		stream, err := docker.HijackExec(ctx, nodeID,
			[]string{"/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -i; else exec /bin/sh -i; fi"},
			[]string{"TERM=xterm-256color"})
		if err != nil {
			log.Printf("terminal hijack: %v", err)
			_ = c.Close(websocket.StatusInternalError, "exec failed")
			return
		}
		defer stream.Close()

		done := make(chan struct{})

		// Keep-alive. A learner reads instructions for minutes at a time without typing, and
		// an idle connection is precisely what an intermediate proxy (Vite's dev proxy here,
		// anything else in front of it later) is most likely to drop silently. A periodic ping
		// keeps it demonstrably alive, and makes a genuinely dead peer surface in seconds
		// rather than hanging until the learner tries to type.
		go func() {
			t := time.NewTicker(20 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-done:
					return
				case <-ctx.Done():
					return
				case <-t.C:
					pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
					err := c.Ping(pctx)
					cancel()
					if err != nil {
						return
					}
				}
			}
		}()

		go func() {
			defer close(done)
			buf := make([]byte, 4096)
			for {
				n, err := stream.Read(buf)
				if n > 0 {
					if werr := c.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
						return
					}
				}
				if err != nil {
					if err != io.EOF {
						log.Printf("terminal read: %v", err)
					}
					return
				}
			}
		}()

		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				break
			}
			if typ == websocket.MessageText {
				var msg struct {
					Type string `json:"type"`
					Cols int    `json:"cols"`
					Rows int    `json:"rows"`
				}
				if json.Unmarshal(data, &msg) == nil && msg.Type == "resize" && msg.Cols > 0 && msg.Rows > 0 {
					_ = docker.ResizeExec(ctx, stream.ExecID, msg.Cols, msg.Rows)
				}
				continue
			}
			if _, err := stream.Write(data); err != nil {
				break
			}
		}
		<-done
	}
}
