package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// hostFixture 提供共享数据库及 Redis 的两个节点。参数由构造器提供；只用于接口测试；不访问真实账号。
type hostFixture struct {
	a, b                  http.Handler
	svc                   *service.Service
	redis                 *miniredis.Miniredis
	primary, phone, other sessionToken
	key                   map[string]any
	generation            string
	client                *redis.Client
}

// newHostFixture 建立跨节点测试环境。参数为测试句柄；返回已经发布公钥的主电脑及两个非主设备；资源随测试关闭。
func newHostFixture(t *testing.T) hostFixture {
	t.Helper()
	mock := miniredis.RunT(t)
	store := storage.NewMemory()
	clientA := redis.NewClient(&redis.Options{Addr: mock.Addr()})
	clientB := redis.NewClient(&redis.Options{Addr: mock.Addr()})
	t.Cleanup(func() { clientA.Close(); clientB.Close() })
	hubA := realtime.New(clientA, "host-test")
	hubB := realtime.New(clientB, "host-test")
	svc := service.New(store, stubGoogle{}, hubA, []byte("0123456789abcdef0123456789abcdef"), 100000)
	f := hostFixture{a: New(svc, store, hubA, "/agents-team").Handler(), b: New(svc, store, hubB, "/agents-team").Handler(), svc: svc, redis: mock, client: clientB}
	f.primary = login(t, f.a, "host-mac-device", "mac")
	f.phone = login(t, f.b, "host-android-device", "android")
	f.other = login(t, f.a, "other-mac-device", "mac")
	device, _, err := svc.Authenticate(context.Background(), f.primary.token)
	if err != nil {
		t.Fatal(err)
	}
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	f.key = map[string]any{"accountId": device.AccountID, "targetDeviceId": device.ID, "keyId": uuid.NewString(), "publicKey": base64.StdEncoding.EncodeToString(der)}
	response := request(f.a, "PUT", "/agents-team/api/v1/host-config/key", f.primary.token, f.key)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var published struct {
		Key hostConfigKey `json:"key"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	f.generation = published.Key.Generation
	return f
}

// create 发起一条配置命令。参数为动作及正文；返回命令编号；默认使用第二节点的手机会话。
func (f hostFixture) create(t *testing.T, action string, payload any) string {
	t.Helper()
	id := uuid.NewString()
	response := request(f.b, "POST", "/agents-team/api/v1/host-config/commands", f.phone.token, map[string]any{"id": id, "targetDeviceId": f.key["targetDeviceId"], "keyId": f.key["keyId"], "generation": f.generation, "action": action, "payload": payload})
	if response.Code != 200 {
		t.Fatalf("创建失败: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "payload") || strings.Contains(response.Body.String(), "sourceHash") {
		t.Fatal("创建响应泄露内部正文")
	}
	return id
}

// claim 解码领取响应。参数为测试句柄及响应；返回命令；非成功状态立即终止测试。
func claimHostTest(t *testing.T, response *httptest.ResponseRecorder) *hostCommand {
	t.Helper()
	if response.Code != 200 {
		t.Fatalf("领取失败: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Command *hostCommand `json:"command"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Command
}

// TestHostCommandCrossNodeClaimAndResult 验证跨节点独占与脱敏结果。参数为测试句柄；无返回值；不启动真实 CLI。
func TestHostCommandCrossNodeClaimAndResult(t *testing.T) {
	f := newHostFixture(t)
	id := f.create(t, "model.get", map[string]any{})
	var responses [2]*httptest.ResponseRecorder
	var wait sync.WaitGroup
	for index, handler := range []http.Handler{f.a, f.b} {
		wait.Add(1)
		go func(index int, handler http.Handler) {
			defer wait.Done()
			responses[index] = request(handler, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil)
		}(index, handler)
	}
	wait.Wait()
	var claimed *hostCommand
	for _, response := range responses {
		item := claimHostTest(t, response)
		if item != nil {
			if claimed != nil {
				t.Fatal("跨节点重复领取")
			}
			claimed = item
		}
	}
	if claimed == nil || claimed.ID != id || claimed.ClaimToken == "" || claimed.SourceHash != "" || claimed.ClaimHash != "" {
		t.Fatal("领取缺失或内部认证摘要泄漏")
	}
	path := "/agents-team/api/v1/host-config/commands/" + id
	for _, token := range []string{f.phone.token, f.other.token} {
		response := request(f.b, "PUT", path, token, map[string]any{"claimToken": claimed.ClaimToken, "result": map[string]any{}})
		if response.Code != 403 {
			t.Fatal("非主设备可以确认配置")
		}
	}
	wrong := request(f.b, "PUT", path, f.primary.token, map[string]any{"claimToken": "wrong", "result": map[string]any{}})
	if wrong.Code != 403 {
		t.Fatal("错误领取令牌被接受")
	}
	response := request(f.b, "PUT", path, f.primary.token, map[string]any{"claimToken": claimed.ClaimToken, "result": map[string]any{"openaiConfigured": true, "openai": "must-not-return", "apiKeys": map[string]string{"custom": "secret"}}})
	if response.Code != 200 || strings.Contains(response.Body.String(), "must-not-return") || strings.Contains(response.Body.String(), "apiKeys") {
		t.Fatalf("结果未脱敏: %s", response.Body.String())
	}
	poll := request(f.a, "GET", path, f.phone.token, nil)
	if poll.Code != 200 || !strings.Contains(poll.Body.String(), `"openaiConfigured":true`) || strings.Contains(poll.Body.String(), "claimToken") {
		t.Fatalf("源设备未读到脱敏结果: %s", poll.Body.String())
	}
	if response := request(f.a, "GET", path, f.other.token, nil); response.Code != 404 {
		t.Fatal("其他同账号设备读取了请求结果")
	}
	state, err := f.svc.LoadState(context.Background(), claimed.AccountID)
	if err != nil || strings.Contains(string(state.Body), id) {
		t.Fatal("配置操作进入聊天快照")
	}
}

// TestHostCommandRejectsPlaintextAndStaleIdentity 验證凭据和主角色边界。参数为测试句柄；无返回值；换主后旧命令不可再执行。
func TestHostCommandRejectsPlaintextAndStaleIdentity(t *testing.T) {
	f := newHostFixture(t)
	for _, input := range []map[string]any{
		{"action": "model.save", "payload": map[string]string{"openai": "plaintext-secret"}},
		{"action": "harness.get", "payload": map[string]string{"secret": "plaintext-secret"}},
		{"action": "shell.exec", "payload": map[string]string{"command": "unsafe"}},
	} {
		input["id"] = uuid.NewString()
		input["targetDeviceId"] = f.key["targetDeviceId"]
		input["keyId"] = f.key["keyId"]
		response := request(f.a, "POST", "/agents-team/api/v1/host-config/commands", f.phone.token, input)
		if response.Code != 400 {
			t.Fatalf("非法请求被接受: %s", response.Body.String())
		}
	}
	if response := request(f.a, "PUT", "/agents-team/api/v1/host-config/key", f.phone.token, f.key); response.Code != 403 {
		t.Fatal("非主设备发布了公钥")
	}
	id := f.create(t, "harness.get", map[string]any{})
	claimed := claimHostTest(t, request(f.a, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil))
	other, _, _ := f.svc.Authenticate(context.Background(), f.other.token)
	if err := f.svc.SetPrimary(context.Background(), other, other.ID); err != nil {
		t.Fatal(err)
	}
	if response := request(f.b, "GET", "/agents-team/api/v1/host-config/key", f.phone.token, nil); response.Code != 409 {
		t.Fatal("换主后旧公钥仍有效")
	}
	if response := request(f.b, "PUT", "/agents-team/api/v1/host-config/commands/"+id, f.primary.token, map[string]any{"claimToken": claimed.ClaimToken, "result": map[string]any{}}); response.Code != 403 {
		t.Fatal("旧主设备可以回写结果")
	}
	f.key["targetDeviceId"] = other.ID
	f.key["keyId"] = uuid.NewString()
	if response := request(f.b, "PUT", "/agents-team/api/v1/host-config/key", f.other.token, f.key); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	request(f.a, "DELETE", "/agents-team/api/v1/host-config/key", f.primary.token, nil)
	if response := request(f.a, "GET", "/agents-team/api/v1/host-config/key", f.phone.token, nil); response.Code != 200 {
		t.Fatal("旧设备清理删除了新主公钥")
	}
}

// TestHostCommandExpiresAndRevokedSourceCannotExecute 验证过期及注销隔离。参数为测试句柄；无返回值；只推进测试 Redis 时间。
func TestHostCommandExpiresAndRevokedSourceCannotExecute(t *testing.T) {
	f := newHostFixture(t)
	id := f.create(t, "harness.probe", map[string]any{})
	phone, _, _ := f.svc.Authenticate(context.Background(), f.phone.token)
	if err := f.svc.Logout(context.Background(), phone); err != nil {
		t.Fatal(err)
	}
	if claimed := claimHostTest(t, request(f.a, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil)); claimed != nil {
		t.Fatal("已注销来源的命令仍被执行")
	}
	f.phone = login(t, f.b, "replacement-phone", "android")
	fresh := f.create(t, "harness.get", map[string]any{})
	f.redis.FastForward(181 * time.Second)
	response := request(f.a, "GET", "/agents-team/api/v1/host-config/commands/"+fresh, f.phone.token, nil)
	if response.Code != 410 {
		t.Fatalf("过期配置仍可读取: %s", response.Body.String())
	}
	if id == fresh {
		t.Fatal("测试编号不应重复")
	}
}

// hostTransactionFailure 注入提交前的 Redis 事务故障。参数由测试启停；不影响认证或普通读取；用于验证双记录原子性。
type hostTransactionFailure struct{ enabled atomic.Bool }

// DialHook 保持连接行为。参数为原始连接处理器；返回原处理器；不注入网络地址错误。
func (h *hostTransactionFailure) DialHook(next redis.DialHook) redis.DialHook { return next }

// ProcessHook 保持普通单命令行为。参数为原处理器；返回原处理器；只在批事务入口注入故障。
func (h *hostTransactionFailure) ProcessHook(next redis.ProcessHook) redis.ProcessHook { return next }

// ProcessPipelineHook 拒绝包含配置写入的整个事务。参数为后续处理器；返回受控处理器；不会执行部分 SET。
func (h *hostTransactionFailure) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, commands []redis.Cmder) error {
		if h.enabled.Load() {
			for _, command := range commands {
				if command.Name() == "set" && strings.Contains(command.String(), ":host-command:") {
					return errors.New("synthetic host transaction outage")
				}
			}
		}
		return next(ctx, commands)
	}
}

// TestHostCommandAtomicFailureAndIdempotency 验证事务失败无孤立记录和严格幂等。参数为测试句柄；无返回值；故障恢复后同编号可正确重试。
func TestHostCommandAtomicFailureAndIdempotency(t *testing.T) {
	f := newHostFixture(t)
	hook := &hostTransactionFailure{}
	f.client.AddHook(hook)
	id := uuid.NewString()
	input := map[string]any{"id": id, "targetDeviceId": f.key["targetDeviceId"], "keyId": f.key["keyId"], "generation": f.generation, "action": "harness.get", "payload": map[string]any{}}
	hook.enabled.Store(true)
	failed := request(f.b, "POST", "/agents-team/api/v1/host-config/commands", f.phone.token, input)
	if failed.Code != 500 {
		t.Fatalf("事务故障未返回错误: %s", failed.Body.String())
	}
	for _, key := range f.redis.Keys() {
		if strings.Contains(key, id) || strings.Contains(key, ":host-queue:") {
			t.Fatal("事务失败留下孤立配置记录")
		}
	}
	hook.enabled.Store(false)
	for index := 0; index < 2; index++ {
		if response := request(f.b, "POST", "/agents-team/api/v1/host-config/commands", f.phone.token, input); response.Code != 200 {
			t.Fatal("同一请求无法安全重试")
		}
	}
	input["action"] = "model.get"
	if response := request(f.a, "POST", "/agents-team/api/v1/host-config/commands", f.phone.token, input); response.Code != 409 {
		t.Fatal("同编号异内容未拒绝")
	}
	hook.enabled.Store(true)
	if response := request(f.b, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil); response.Code != 500 {
		t.Fatal("领取事务故障未返回错误")
	}
	hook.enabled.Store(false)
	claimed := claimHostTest(t, request(f.b, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil))
	if claimed == nil || claimed.ID != id {
		t.Fatal("领取事务失败后无法重新领取原任务")
	}
}

// TestHostCommandLeaseRedelivery 验证领取响应丢失可恢复。参数为测试句柄；无返回值；旧租约不得确认重新领取的命令。
func TestHostCommandLeaseRedelivery(t *testing.T) {
	f := newHostFixture(t)
	id := f.create(t, "model.get", map[string]any{})
	first := claimHostTest(t, request(f.a, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil))
	if first == nil {
		t.Fatal("首次领取失败")
	}
	if duplicate := claimHostTest(t, request(f.b, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil)); duplicate != nil {
		t.Fatal("有效租约内重复交付")
	}
	key := "host-test:transient:host-command:" + first.AccountID + ":" + id
	raw, err := f.redis.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	var stored hostCommand
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatal(err)
	}
	stored.ClaimExpiresAt = time.Now().Add(-time.Second)
	body, _ := json.Marshal(stored)
	f.redis.Set(key, string(body))
	f.redis.SetTTL(key, 2*time.Minute)
	second := claimHostTest(t, request(f.b, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil))
	if second == nil || second.ID != id || second.ClaimToken == first.ClaimToken {
		t.Fatal("租约到期后没有重新交付同一命令")
	}
	path := "/agents-team/api/v1/host-config/commands/" + id
	if response := request(f.a, "PUT", path, f.primary.token, map[string]any{"claimToken": first.ClaimToken, "result": map[string]any{}}); response.Code != 403 {
		t.Fatal("旧租约可以回写")
	}
	if response := request(f.a, "PUT", path, f.primary.token, map[string]any{"claimToken": second.ClaimToken, "result": map[string]any{"openaiConfigured": true}}); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if after := claimHostTest(t, request(f.a, "GET", "/agents-team/api/v1/host-config/commands", f.primary.token, nil)); after != nil {
		t.Fatal("已完成配置重复交付")
	}
}
