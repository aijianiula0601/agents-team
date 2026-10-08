package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"agents-team-relay/internal/storage"
)

// teamMutation 保存一次测试配置并返回完整快照。
//
// 参数：t 和 svc 为测试上下文；device 为会话，其余参数描述配置操作。
// 返回值：成功保存的状态；失败时终止当前测试。
// 注意事项：只使用内存存储，config 为空字符串代表删除请求。
func teamMutation(t *testing.T, svc *Service, device storage.Device, revision int64, collection, action, id, config string) storage.State {
	t.Helper()
	saved, err := svc.MutateTeamConfig(context.Background(), device, TeamConfigMutation{Collection: collection, Action: action, ID: id, BaseRevision: revision, Config: json.RawMessage(config)})
	if err != nil {
		t.Fatalf("配置操作失败 %s/%s: %v", collection, action, err)
	}
	return saved
}

// TestPhoneInitializesSharedTeamWithoutPrimary 验证只有手机的新账号也能先配置主电脑的团队。
//
// 参数：t 为测试句柄。
// 返回值：无；初始化、幂等或共享偏好错误时失败。
// 注意事项：没有电脑会话，不允许创建操作隐式把手机提升为执行设备。
func TestPhoneInitializesSharedTeamWithoutPrimary(t *testing.T) {
	svc, _ := testService()
	phone := testLogin(t, svc, "new-phone@example.com", "new-phone-device", "android", "register")
	config := `{"name":"远端助手","backend":"cursor","workspaceMode":"auto","workspace":""}`
	created := teamMutation(t, svc, phone.Device, 0, "agents", "create", "a1", config)
	if created.Revision != 1 || configRevision(created.Body) != 1 || !strings.Contains(string(created.Body), `"localExecution":true`) || !strings.Contains(string(created.Body), `"defaultProvider":"openai"`) || !strings.Contains(string(created.Body), `"messages":[]`) {
		t.Fatal("初始共享配置缺失默认值或版本")
	}
	room := teamMutation(t, svc, phone.Device, 1, "rooms", "create", "r1", `{"name":"远端团队","agentIds":["a1"]}`)
	// 原创建响应丢失后，即使期间创建了群，重试也应返回当前版本而不重复创建。
	replay := teamMutation(t, svc, phone.Device, 0, "agents", "create", "a1", config)
	if replay.Revision != room.Revision || string(replay.Body) != string(room.Body) {
		t.Fatal("重复创建没有幂等返回当前状态")
	}
	_, err := svc.MutateTeamConfig(context.Background(), phone.Device, TeamConfigMutation{Collection: "agents", Action: "create", ID: "a1", Config: json.RawMessage(`{"name":"不同内容"}`)})
	if businessCode(err) != "CONFIG_EXISTS" {
		t.Fatalf("相同编号异内容未拒绝: %v", err)
	}
	shared := teamMutation(t, svc, phone.Device, 2, "settings", "update", "", `{"localExecution":false,"defaultProvider":"anthropic"}`)
	if configRevision(shared.Body) != 3 || !strings.Contains(string(shared.Body), `"localExecution":false`) || !strings.Contains(string(shared.Body), `"rule":"free"`) {
		t.Fatal("群默认规则或共享偏好没有持久化")
	}
	devices, err := svc.ListDevices(context.Background(), phone.Account.ID)
	if err != nil || len(devices) != 1 || devices[0].IsPrimary {
		t.Fatal("手机被配置操作提升成主设备")
	}
}

// TestTeamCRUDPreservesMessagesAndCleansMembership 验证跨设备增删群和成员不会覆盖已有聊天。
//
// 参数：t 为测试句柄。
// 返回值：无；历史、引用、最后成员或其他顶层字段错误时失败。
// 注意事项：删掉某群唯一成员时回填剩余首位 Agent，保留群历史。
func TestTeamCRUDPreservesMessagesAndCleansMembership(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "crud@example.com", "crud-primary", "mac", "register")
	secondary := testLogin(t, svc, "crud@example.com", "crud-secondary", "mac", "login")
	original := json.RawMessage(`{"agents":[{"id":"a1","name":"初始","messages":[{"id":"a-history","text":"私聊历史"}]}],"rooms":[{"id":"r1","name":"初始群","agentIds":["a1"],"rule":"free","workspace":"","messages":[{"id":"r-history","text":"群聊历史"}]}],"harnessModels":{"cursor":[{"id":"test-model"}]},"execution":{"running":null},"settings":{"theme":"dark","localExecution":true}}`)
	if _, err := svc.SaveState(ctx, primary.Device, 0, original); err != nil {
		t.Fatal(err)
	}
	teamMutation(t, svc, secondary.Device, 1, "agents", "create", "a2", `{"name":"协作者","backend":"codex","workspaceMode":"project","workspace":"/主电脑/项目"}`)
	teamMutation(t, svc, secondary.Device, 2, "rooms", "update", "r1", `{"name":"新的群名","agentIds":["a1","a2"],"workspace":"/主电脑/群目录","rule":"mention"}`)
	teamMutation(t, svc, secondary.Device, 3, "rooms", "create", "r2", `{"name":"单成员群","agentIds":["a2"]}`)
	deleted := teamMutation(t, svc, secondary.Device, 4, "agents", "delete", "a2", "")
	var state struct {
		Agents []map[string]any
		Rooms  []struct {
			ID       string
			AgentIDs []string `json:"agentIds"`
		}
	}
	if err := json.Unmarshal(deleted.Body, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Agents) != 1 || len(state.Rooms) != 2 || len(state.Rooms[0].AgentIDs) != 1 || state.Rooms[0].AgentIDs[0] != "a1" || len(state.Rooms[1].AgentIDs) != 1 || state.Rooms[1].AgentIDs[0] != "a1" {
		t.Fatal("删除 Agent 后没有清理群引用并回填最后成员")
	}
	final := teamMutation(t, svc, secondary.Device, 5, "rooms", "delete", "r2", "")
	for _, expected := range []string{"私聊历史", "群聊历史", "新的群名", "/主电脑/群目录", `"harnessModels"`, `"execution"`, `"theme":"dark"`} {
		if !strings.Contains(string(final.Body), expected) {
			t.Fatalf("变更丢失既有数据: %s", expected)
		}
	}
	_, err := svc.MutateTeamConfig(ctx, secondary.Device, TeamConfigMutation{Collection: "agents", Action: "delete", ID: "a1", BaseRevision: 6})
	if businessCode(err) != "LAST_AGENT" {
		t.Fatal("删除了最后一位 Agent")
	}
}

// TestSharedConfigSnapshotFenceAllowsMessagesAndAutoWorkspace 验证旧主电脑不能借新版本恢复旧配置。
//
// 参数：t 为测试句柄。
// 返回值：无；配置绕过或正常聊天被阻止时失败。
// 注意事项：允许主电脑填充 auto 工作区实际路径，显式项目目录仍由配置接口管理。
func TestSharedConfigSnapshotFenceAllowsMessagesAndAutoWorkspace(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "fence@example.com", "fence-primary", "mac", "register")
	created := teamMutation(t, svc, primary.Device, 0, "agents", "create", "a1", `{"name":"新助手","workspaceMode":"auto","workspace":""}`)
	for _, body := range []string{
		`{"agents":[],"rooms":[],"configRevision":1,"settings":{"localExecution":true,"defaultProvider":"openai"}}`,
		`{"agents":[{"id":"a1","name":"旧名字","workspaceMode":"auto","workspace":""}],"rooms":[],"configRevision":1,"settings":{"localExecution":true,"defaultProvider":"openai"}}`,
		`{"agents":[{"id":"a1","name":"新助手","workspaceMode":"auto","workspace":""}],"rooms":[{"id":"旧群"}],"configRevision":1,"settings":{"localExecution":true,"defaultProvider":"openai"}}`,
		`{"agents":[{"id":"a1","name":"新助手","workspaceMode":"auto","workspace":""}],"rooms":[],"configRevision":1,"settings":{"localExecution":false,"defaultProvider":"openai"}}`,
	} {
		if _, err := svc.SaveState(ctx, primary.Device, created.Revision, json.RawMessage(body)); businessCode(err) != "REVISION_CONFLICT" {
			t.Fatalf("旧共享配置覆盖未被拒绝: %v", err)
		}
	}
	document, _ := decodeObject(created.Body)
	agent := document["agents"].([]any)[0].(map[string]any)
	agent["workspace"] = "/Users/main/Chorus/default-a1"
	agent["messages"] = []any{map[string]any{"id": "new-message", "text": "新消息"}}
	document["execution"] = map[string]any{"running": nil}
	document["harnessModels"] = map[string]any{"cursor": []any{map[string]any{"id": "auto"}}}
	document["settings"].(map[string]any)["theme"] = "light"
	body, _ := json.Marshal(document)
	saved, err := svc.SaveState(ctx, primary.Device, 1, body)
	if err != nil || !strings.Contains(string(saved.Body), "新消息") || !strings.Contains(string(saved.Body), "/Users/main/Chorus/default-a1") {
		t.Fatalf("正常消息或 auto 实际路径无法保存: %v", err)
	}
	configured := teamMutation(t, svc, primary.Device, 2, "agents", "update", "a1", `{"workspaceMode":"project","workspace":"/main/project"}`)
	changed := strings.Replace(string(configured.Body), "/main/project", "/secondary/wrong", 1)
	if _, err := svc.SaveState(ctx, primary.Device, 3, json.RawMessage(changed)); businessCode(err) != "REVISION_CONFLICT" {
		t.Fatal("整份快照覆盖了显式主电脑项目目录")
	}
}

// TestConfigChangesInterleaveWithDispatchWithoutLosingChat 验证聊天与配置串行事务冲突及安全重试。
//
// 参数：t 为测试句柄。
// 返回值：无；消息、任务引用或编辑结果丢失时失败。
// 注意事项：在途群任务保护所有成员，不能只保护第一位 responder。
func TestConfigChangesInterleaveWithDispatchWithoutLosingChat(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "busy@example.com", "busy-primary", "mac", "register")
	phone := testLogin(t, svc, "busy@example.com", "busy-phone", "android", "login")
	initial := json.RawMessage(`{"agents":[{"id":"a1","name":"首位","messages":[]},{"id":"a2","name":"后续","messages":[]}],"rooms":[{"id":"r1","name":"团队","agentIds":["a1","a2"],"messages":[]}]}`)
	if _, err := svc.SaveState(ctx, primary.Device, 0, initial); err != nil {
		t.Fatal(err)
	}
	job, revision, err := svc.CreateDispatch(ctx, phone.Device, DispatchInput{ClientRequestID: "busy-request-1", RoomID: "r1", Mode: "discuss", UserText: "并发消息", UserMessage: json.RawMessage(`{"id":"busy-request-1","text":"并发消息"}`), Responders: []MessageInput{{AgentID: "a1"}}})
	if err != nil || revision != 2 {
		t.Fatal(err)
	}
	if _, err := svc.MutateTeamConfig(ctx, phone.Device, TeamConfigMutation{Collection: "agents", Action: "create", ID: "a3", BaseRevision: 1, Config: json.RawMessage(`{"name":"新成员"}`)}); businessCode(err) != "REVISION_CONFLICT" {
		t.Fatal("并发聊天未引发旧配置版本冲突")
	}
	created := teamMutation(t, svc, phone.Device, 2, "agents", "create", "a3", `{"name":"新成员"}`)
	if !strings.Contains(string(created.Body), "并发消息") {
		t.Fatal("安全重试丢失并发聊天")
	}
	for _, mutation := range []TeamConfigMutation{
		{Collection: "agents", Action: "delete", ID: "a2", BaseRevision: 3},
		{Collection: "rooms", Action: "delete", ID: "r1", BaseRevision: 3},
		{Collection: "rooms", Action: "update", ID: "r1", BaseRevision: 3, Config: json.RawMessage(`{"agentIds":["a1"]}`)},
	} {
		if _, err := svc.MutateTeamConfig(ctx, phone.Device, mutation); businessCode(err) != "CONFIG_IN_USE" {
			t.Fatalf("在途任务关联实体可被删除或移除: %v", err)
		}
	}
	teamMutation(t, svc, phone.Device, 3, "rooms", "update", "r1", `{"name":"任务中的新群名"}`)
	lease, err := svc.ClaimDispatch(ctx, primary.Device)
	if err != nil || lease == nil {
		t.Fatal("任务领取失败")
	}
	_, _, err = svc.CompleteDispatch(ctx, primary.Device, job.ID, ResultInput{Status: "done", ClaimToken: lease.ClaimToken, Replies: []MessageInput{{AgentID: "a2", Message: json.RawMessage(`{"id":"busy-reply","text":"后续成员回复"}`)}}})
	if err != nil {
		t.Fatal(err)
	}
	deleted := teamMutation(t, svc, phone.Device, 5, "agents", "delete", "a2", "")
	if !strings.Contains(string(deleted.Body), "后续成员回复") || !strings.Contains(string(deleted.Body), "任务中的新群名") {
		t.Fatal("任务完成后的删除丢失群历史或新配置")
	}
}

// TestTeamConfigValidationAndSessionIsolation 验证权限、字段白名单和引用合法性。
//
// 参数：t 为测试句柄。
// 返回值：无；非法配置、跨账号或过期设备被接受时失败。
// 注意事项：配置接口绝不接受消息、密钥、其他设备设置或未知字段。
func TestTeamConfigValidationAndSessionIsolation(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	phone := testLogin(t, svc, "validation@example.com", "validation-phone", "android", "register")
	teamMutation(t, svc, phone.Device, 0, "agents", "create", "a1", `{"name":"Existing"}`)
	invalid := []TeamConfigMutation{
		{Collection: "agents", Action: "create", ID: "a2", Config: json.RawMessage(`{"name":"has space"}`)},
		{Collection: "agents", Action: "create", ID: "a2", Config: json.RawMessage(`{"name":"has@mention"}`)},
		{Collection: "agents", Action: "create", ID: "a2", Config: json.RawMessage(`{"name":"new","messages":[]}`)},
		{Collection: "agents", Action: "create", ID: "a2", Config: json.RawMessage(`{"name":"new","apiKey":"secret"}`)},
		{Collection: "agents", Action: "create", ID: "a2", Config: json.RawMessage(`{"backend":"cursor"}`)},
		{Collection: "rooms", Action: "create", ID: "r1", Config: json.RawMessage(`{"name":"room","agentIds":[]}`)},
		{Collection: "rooms", Action: "create", ID: "r1", Config: json.RawMessage(`{"name":"room","agentIds":["a1","a1"]}`)},
		{Collection: "rooms", Action: "create", ID: "r1", Config: json.RawMessage(`{"name":"room","agentIds":["missing"]}`)},
		{Collection: "rooms", Action: "create", ID: "r1", Config: json.RawMessage(`{"name":"room","agentIds":["a1"],"rule":"serial"}`)},
		{Collection: "rooms", Action: "create", ID: "r1", Config: json.RawMessage(`{"name":"room","agentIds":["a1"],"messages":[]}`)},
		{Collection: "settings", Action: "update", Config: json.RawMessage(`{"theme":"dark"}`)},
		{Collection: "settings", Action: "update", Config: json.RawMessage(`{"apiKeys":{}}`)},
		{Collection: "settings", Action: "update", Config: json.RawMessage(`{"localExecution":"true"}`)},
		{Collection: "settings", Action: "update", Config: json.RawMessage(`{"defaultProvider":"other"}`)},
		{Collection: "agents", Action: "delete", ID: "a1", Config: json.RawMessage(`{}`)},
	}
	for _, mutation := range invalid {
		mutation.BaseRevision = 1
		if _, err := svc.MutateTeamConfig(ctx, phone.Device, mutation); businessCode(err) != "INVALID" {
			t.Fatalf("非法配置被接受: %+v (%v)", mutation, err)
		}
	}
	if _, err := svc.MutateTeamConfig(ctx, phone.Device, TeamConfigMutation{Collection: "agents", Action: "create", ID: "a2", BaseRevision: 1, Config: json.RawMessage(`{"name":"existing"}`)}); businessCode(err) != "CONFIG_EXISTS" {
		t.Fatal("大小写不敏感名称重复未拒绝")
	}
	outsider := testLogin(t, svc, "outside-config@example.com", "outside-phone", "android", "register")
	if _, err := svc.MutateTeamConfig(ctx, outsider.Device, TeamConfigMutation{Collection: "agents", Action: "delete", ID: "a1"}); businessCode(err) != "AGENT_NOT_FOUND" {
		t.Fatal("跨账号删除泄露或修改其他账号配置")
	}
	testLogin(t, svc, "validation@example.com", "validation-phone", "android", "login")
	if _, err := svc.MutateTeamConfig(ctx, phone.Device, TeamConfigMutation{Collection: "settings", Action: "update", BaseRevision: 1, Config: json.RawMessage(`{"localExecution":false}`)}); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("轮换后旧会话仍能修改共享设置")
	}
}

// TestConcurrentTeamConfigCreationAndLimits 验证同版本并发创建只有一个成功且数量受限。
//
// 参数：t 为测试句柄。
// 返回值：无；账号锁或 200 个实体上限错误时失败。
// 注意事项：使用同步起跑并检查最终状态，冲突调用方必须重新拉取后重试。
func TestConcurrentTeamConfigCreationAndLimits(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "parallel-config@example.com", "parallel-config-primary", "mac", "register")
	teamMutation(t, svc, primary.Device, 0, "agents", "create", "first", `{"name":"first"}`)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for index := 0; index < 2; index++ {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			id := fmt.Sprintf("parallel-%d", index)
			_, err := svc.MutateTeamConfig(ctx, primary.Device, TeamConfigMutation{Collection: "agents", Action: "create", ID: id, BaseRevision: 1, Config: json.RawMessage(`{"name":"` + id + `"}`)})
			results <- err
		}(index)
	}
	close(start)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if businessCode(err) == "REVISION_CONFLICT" {
			conflicts++
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("并发同版本配置没有原子冲突")
	}
	other := testLogin(t, svc, "limit-config@example.com", "limit-primary", "mac", "register")
	agents := []map[string]any{}
	rooms := []map[string]any{}
	for index := 0; index < 200; index++ {
		agents = append(agents, map[string]any{"id": fmt.Sprintf("a%d", index), "name": fmt.Sprintf("agent%d", index)})
		rooms = append(rooms, map[string]any{"id": fmt.Sprintf("r%d", index), "name": "room", "agentIds": []string{"a0"}})
	}
	body, _ := json.Marshal(map[string]any{"agents": agents, "rooms": rooms})
	if _, err := svc.SaveState(ctx, other.Device, 0, body); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []TeamConfigMutation{{Collection: "agents", Action: "create", ID: "overflow", BaseRevision: 1, Config: json.RawMessage(`{"name":"overflow"}`)}, {Collection: "rooms", Action: "create", ID: "overflow", BaseRevision: 1, Config: json.RawMessage(`{"name":"overflow","agentIds":["a0"]}`)}} {
		if _, err := svc.MutateTeamConfig(ctx, other.Device, mutation); businessCode(err) != "CONFIG_LIMIT" {
			t.Fatal("实体数量上限未生效")
		}
	}
}

// TestLocalPrimaryRunProtectsConfigAndAutoCreationReplay 验证本机执行标记及派生工作区的创建幂等。
//
// 参数：t 为测试句柄。
// 返回值：无；本机运行中删除或网络重试重复创建时失败。
// 注意事项：主电脑本地聊天没有服务端派发记录，必须检查快照执行状态。
func TestLocalPrimaryRunProtectsConfigAndAutoCreationReplay(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "local-run@example.com", "local-run-primary", "mac", "register")
	phone := testLogin(t, svc, "local-run@example.com", "local-run-phone", "android", "login")
	config := `{"name":"本机成员","workspaceMode":"auto","workspace":""}`
	teamMutation(t, svc, phone.Device, 0, "agents", "create", "a1", config)
	teamMutation(t, svc, phone.Device, 1, "agents", "create", "a2", `{"name":"后续成员"}`)
	created := teamMutation(t, svc, phone.Device, 2, "rooms", "create", "r1", `{"name":"本机任务群","agentIds":["a1","a2"]}`)
	document, _ := decodeObject(created.Body)
	document["agents"].([]any)[0].(map[string]any)["workspace"] = "/Users/main/Chorus/a1"
	document["execution"] = map[string]any{"running": map[string]any{"key": "room:r1", "agentId": "a1", "agentIds": []string{"a1"}}}
	body, _ := json.Marshal(document)
	if _, err := svc.SaveState(ctx, primary.Device, 3, body); err != nil {
		t.Fatal(err)
	}
	replay := teamMutation(t, svc, phone.Device, 0, "agents", "create", "a1", config)
	if replay.Revision != 4 {
		t.Fatal("主电脑填充实际 auto 路径后创建重试不再幂等")
	}
	for _, mutation := range []TeamConfigMutation{
		{Collection: "rooms", Action: "delete", ID: "r1", BaseRevision: 4},
		{Collection: "agents", Action: "delete", ID: "a2", BaseRevision: 4},
		{Collection: "rooms", Action: "update", ID: "r1", BaseRevision: 4, Config: json.RawMessage(`{"agentIds":["a1"]}`)},
	} {
		if _, err := svc.MutateTeamConfig(ctx, phone.Device, mutation); businessCode(err) != "CONFIG_IN_USE" {
			t.Fatalf("主电脑本地运行中的会话或后续成员被删除: %v", err)
		}
	}
}
