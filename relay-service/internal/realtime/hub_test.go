package realtime

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestRedisCrossNodeEventsTicketsAndRateLimits(t *testing.T) {
	mock := miniredis.RunT(t)
	clientA := redis.NewClient(&redis.Options{Addr: mock.Addr()})
	defer clientA.Close()
	clientB := redis.NewClient(&redis.Options{Addr: mock.Addr()})
	defer clientB.Close()
	a := New(clientA, "agents-team:test")
	b := New(clientB, "agents-team:test")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.Run(ctx)
	go b.Run(ctx)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		counts, err := clientA.PubSubNumSub(ctx, a.channel).Result()
		if err == nil && counts[a.channel] == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	counts, _ := clientA.PubSubNumSub(ctx, a.channel).Result()
	if counts[a.channel] != 2 {
		t.Fatal("两个节点未订阅Redis")
	}
	recipient := b.Register("account-one", "phone-one")
	defer b.Unregister(recipient)
	other := b.Register("other-account", "other-phone")
	defer b.Unregister(other)
	if err := a.Publish(ctx, Event{AccountID: "account-one", Type: "state.updated", Revision: 7}); err != nil {
		t.Fatal(err)
	}
	select {
	case message := <-recipient.Send():
		var event Event
		if err := json.Unmarshal(message, &event); err != nil || event.Revision != 7 {
			t.Fatal(string(message))
		}
	case <-time.After(time.Second):
		t.Fatal("其他节点未实时收到聊天通知")
	}
	select {
	case <-other.Send():
		t.Fatal("账号间广播未隔离")
	default:
	}
	a.MarkOnline(ctx, "desktop-a")
	if !b.Online(ctx, []string{"desktop-a"})["desktop-a"] {
		t.Fatal("在线状态未跨节点共享")
	}
	if err := a.PutTransient(ctx, "ticket-one", "encrypted-only", time.Minute); err != nil {
		t.Fatal(err)
	}
	body, err := b.TakeTransient(ctx, "ticket-one")
	if err != nil || body != "encrypted-only" {
		t.Fatal("ticket不能跨节点核销")
	}
	if _, err := a.TakeTransient(ctx, "ticket-one"); !IsTransientMissing(err) {
		t.Fatal("ticket可二次核销")
	}
	if !a.AllowAttempt(ctx, "login-source", 1, time.Minute) || b.AllowAttempt(ctx, "login-source", 1, time.Minute) {
		t.Fatal("限流计数未跨节点共享")
	}
	mock.FastForward(time.Minute + time.Second)
	if !b.AllowAttempt(ctx, "login-source", 1, time.Minute) {
		t.Fatal("限流窗口未过期")
	}
	isolated := New(clientA, "other-service:test")
	if _, err := isolated.GetTransient(ctx, "ticket-one"); !IsTransientMissing(err) {
		t.Fatal("Redis namespace隔离失败")
	}
}
