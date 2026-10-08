package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
)

func TestDispatchPersistsAndDeliversCanonicalUserMessage(t *testing.T) {
	for _, test := range []struct {
		name   string
		room   bool
		legacy bool
	}{{"team", true, false}, {"private", false, false}, {"legacy-team", true, true}, {"legacy-private", false, true}} {
		t.Run(test.name, func(t *testing.T) {
			store := storage.NewMemory()
			hub := realtime.New(nil, "canonical-dispatch")
			svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
			handler := New(svc, store, hub, "/agents-team").Handler()
			pc := login(t, handler, "canonical-desktop", "mac")
			phone := login(t, handler, "canonical-phone", "android")
			snapshot := map[string]any{"agents": []any{map[string]any{"id": "a1", "messages": []any{}}}, "rooms": []any{map[string]any{"id": "r1", "agentIds": []string{"a1"}, "messages": []any{}}}}
			response := request(handler, "PUT", "/agents-team/api/v1/state", pc.token, map[string]any{"baseRevision": 0, "state": snapshot})
			if response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			requestID := "canonical-" + test.name
			user := map[string]any{"id": requestID, "from": "spoofed", "text": "phone message", "attachments": []any{map[string]any{"name": "note.txt", "text": "attachment body"}}}
			responder := map[string]any{"agentId": "a1"}
			payload := map[string]any{"clientRequestId": requestID, "mode": "execute", "userText": "phone message with expanded attachment", "responders": []any{responder}}
			if test.room {
				payload["roomId"] = "r1"
			} else {
				payload["agentId"] = "a1"
			}
			if test.legacy {
				user["id"] = "old-agent-specific-id"
				responder["message"] = user
			} else {
				payload["userMessage"] = user
			}
			response = request(handler, "POST", "/agents-team/api/v1/dispatches", phone.token, payload)
			if response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			var created struct {
				Dispatch service.DispatchRecord `json:"dispatch"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
				t.Fatal(err)
			}
			assertCanonicalUser(t, created.Dispatch.UserMessage, requestID)
			stored, err := store.FindDispatch(context.Background(), created.Dispatch.AccountID, created.Dispatch.ID)
			if err != nil {
				t.Fatal(err)
			}
			var persisted service.DispatchInput
			if err := json.Unmarshal(stored.Payload, &persisted); err != nil {
				t.Fatal(err)
			}
			assertCanonicalUser(t, persisted.UserMessage, requestID)
			if test.legacy {
				assertCanonicalUser(t, persisted.Responders[0].Message, requestID)
			}
			response = request(handler, "GET", "/agents-team/api/v1/dispatches/"+created.Dispatch.ID, phone.token, nil)
			if response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			var queried struct {
				Dispatch service.DispatchRecord `json:"dispatch"`
			}
			json.Unmarshal(response.Body.Bytes(), &queried)
			assertCanonicalUser(t, queried.Dispatch.UserMessage, requestID)
			response = request(handler, "POST", "/agents-team/api/v1/dispatches/claim", pc.token, map[string]any{})
			if response.Code != http.StatusOK {
				t.Fatal(response.Body.String())
			}
			var claimed struct {
				Dispatch service.DispatchRecord `json:"dispatch"`
			}
			json.Unmarshal(response.Body.Bytes(), &claimed)
			if claimed.Dispatch.ID != created.Dispatch.ID || claimed.Dispatch.ClaimToken == "" {
				t.Fatal("wrong dispatch or missing claim token")
			}
			assertCanonicalUser(t, claimed.Dispatch.UserMessage, requestID)
			state, err := store.LoadState(context.Background(), created.Dispatch.AccountID)
			if err != nil {
				t.Fatal(err)
			}
			var document struct {
				Agents []struct{ Messages []json.RawMessage }
				Rooms  []struct{ Messages []json.RawMessage }
			}
			if err := json.Unmarshal(state.Body, &document); err != nil {
				t.Fatal(err)
			}
			messages := document.Agents[0].Messages
			if test.room {
				messages = document.Rooms[0].Messages
			}
			if len(messages) != 1 {
				t.Fatalf("wrong snapshot message count: %d", len(messages))
			}
			assertCanonicalUser(t, messages[0], requestID)
		})
	}
}
func assertCanonicalUser(t *testing.T, raw json.RawMessage, requestID string) {
	t.Helper()
	var message struct {
		ID          string `json:"id"`
		From        string `json:"from"`
		Text        string `json:"text"`
		Attachments []struct {
			Name string `json:"name"`
			Text string `json:"text"`
		} `json:"attachments"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatal(err)
	}
	if message.ID != requestID || message.From != "you" || message.Text != "phone message" || len(message.Attachments) != 1 || message.Attachments[0].Text != "attachment body" {
		t.Fatalf("noncanonical user message or lost content: %s", raw)
	}
}
