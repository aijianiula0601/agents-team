package service

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// sanitizeState 删除聊天快照里的密钥并检查大小。
//
// 参数：body 为客户端提交的 JSON；limit 为最大字节数。
// 返回值：可入库的 JSON。超限或格式错误时返回业务错误。
// 注意事项：只删除 settings 中的密钥字段，消息正文保持原样。
func sanitizeState(body json.RawMessage, limit int) ([]byte, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, fail(400, "INVALID", "缺少聊天记录")
	}
	if len(body) > limit {
		return nil, fail(400, "INVALID", "聊天记录过大")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var document map[string]any
	if err := decoder.Decode(&document); err != nil || document == nil {
		return nil, fail(400, "INVALID", "聊天记录必须是 JSON 对象")
	}
	stripSecrets(document)
	clean, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	if len(clean) > limit {
		return nil, fail(400, "INVALID", "聊天记录过大")
	}
	return clean, nil
}

// appendMessages 把消息追加到对应 Agent 的 messages。
//
// 参数：body 为当前快照；inputs 为待追加消息；limit 为快照上限。
// 返回值：新的快照 JSON。Agent 不存在或消息不合法时返回业务错误。
// 注意事项：相同消息 id 只保留一次。每个 Agent 最多保留最近 200 条。
func appendMessages(body []byte, inputs []MessageInput, limit int) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var document map[string]any
	if err := decoder.Decode(&document); err != nil || document == nil {
		return nil, fail(409, "STATE_EMPTY", "还没有可同步的聊天记录")
	}
	agents, ok := document["agents"].([]any)
	if !ok {
		return nil, fail(409, "STATE_EMPTY", "还没有可同步的聊天记录")
	}
	for _, input := range inputs {
		if input.AgentID == "" {
			return nil, fail(400, "INVALID", "缺少 Agent 编号")
		}
		message, err := decodeObject(input.Message)
		if err != nil {
			return nil, err
		}
		messageID, _ := message["id"].(string)
		if messageID == "" {
			return nil, fail(400, "INVALID", "消息缺少 id")
		}
		if text, _ := message["text"].(string); utf8.RuneCountInString(text) > 200000 {
			return nil, fail(400, "INVALID", "消息过长")
		}
		found := false
		for index, raw := range agents {
			agent, ok := raw.(map[string]any)
			if !ok || stringValue(agent["id"]) != input.AgentID {
				continue
			}
			found = true
			messages, _ := agent["messages"].([]any)
			if !hasMessage(messages, messageID) {
				messages = append(messages, message)
				agent["messages"] = messages
				agents[index] = agent
			}
			break
		}
		if !found {
			return nil, fail(404, "AGENT_NOT_FOUND", "聊天记录里没有这个 Agent")
		}
	}
	document["agents"] = agents
	stripSecrets(document)
	clean, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	if len(clean) > limit {
		return nil, fail(400, "INVALID", "聊天记录过大")
	}
	return clean, nil
}

// stripSecrets 删除设置里的模型密钥和令牌。
//
// 参数：document 为聊天快照对象。
// 返回值：无。
// 注意事项：直接修改传入 map。
func stripSecrets(document map[string]any) {
	stripConfigSecrets(document)
}

// stripConfigSecrets 递归移除配置中的凭据，消息正文与附件内容保留原样。
func stripConfigSecrets(value any) {
	switch object := value.(type) {
	case map[string]any:
		for key, child := range object {
			normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
			switch normalized {
			case "apikeys", "apikey", "accesstoken", "refreshtoken", "devicetoken", "password", "passwordhash", "clientsecret", "googleclientsecret", "tokenkey", "privatekey", "authorization", "relaysession":
				delete(object, key)
			case "messages", "attachments":
				// 对话和附件是用户资料，不能在这里改写它们。
			default:
				stripConfigSecrets(child)
			}
		}
	case []any:
		for _, child := range object {
			stripConfigSecrets(child)
		}
	}
}

// hasMessage 判断消息列表里是否已有同一 id。
//
// 参数：messages 为 Agent 消息数组；messageID 为要查的 id。
// 返回值：已存在时返回 true。
// 注意事项：只比较字符串 id。
func hasMessage(messages []any, messageID string) bool {
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if ok && stringValue(message["id"]) == messageID {
			return true
		}
	}
	return false
}

// stringValue 读取 JSON 字符串字段。
//
// 参数：value 为解码后的值。
// 返回值：不是字符串时返回空字符串。
// 注意事项：不要用 fmt 把数字改写成字符串后再比较。
func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

// appendDispatchMessages 按原会话写入团队或私聊消息，团队消息不再误写入私聊。
func appendDispatchMessages(body []byte, roomID, agentID string, userMessage json.RawMessage, inputs []MessageInput, user bool, limit int) ([]byte, error) {
	if roomID == "" {
		inputs = append([]MessageInput(nil), inputs...)
		if user && len(userMessage) > 0 {
			for i := range inputs {
				inputs[i].Message = userMessage
			}
		}
		if agentID != "" {
			for _, item := range inputs {
				if item.AgentID != agentID {
					return nil, fail(400, "INVALID", "私聊回复 Agent 与目标不一致")
				}
			}
		}
		for index, item := range inputs {
			message, err := decodeObject(item.Message)
			if err != nil {
				return nil, err
			}
			if user {
				message["from"] = "you"
			} else {
				message["from"] = item.AgentID
			}
			encoded, err := json.Marshal(message)
			if err != nil {
				return nil, err
			}
			inputs[index].Message = encoded
		}
		return appendMessages(body, inputs, limit)
	}
	var document map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return nil, fail(409, "STATE_EMPTY", "还没有可同步的聊天记录")
	}
	agents, _ := document["agents"].([]any)
	for _, item := range inputs {
		found := false
		for _, raw := range agents {
			a, _ := raw.(map[string]any)
			if stringValue(a["id"]) == item.AgentID {
				found = true
				break
			}
		}
		if !found {
			return nil, fail(404, "AGENT_NOT_FOUND", "聊天记录里没有这个 Agent")
		}
	}
	rooms, _ := document["rooms"].([]any)
	for _, raw := range rooms {
		room, ok := raw.(map[string]any)
		if !ok || stringValue(room["id"]) != roomID {
			continue
		}
		if members, ok := room["agentIds"].([]any); ok {
			for _, item := range inputs {
				member := false
				for _, id := range members {
					if stringValue(id) == item.AgentID {
						member = true
					}
				}
				if !member {
					return nil, fail(400, "INVALID", "回复 Agent 不属于这个团队")
				}
			}
		}
		messages, _ := room["messages"].([]any)
		pending := inputs
		if user {
			if len(userMessage) == 0 && len(inputs) > 0 {
				userMessage = inputs[0].Message
			}
			pending = []MessageInput{{Message: userMessage}}
		}
		for _, item := range pending {
			message, err := decodeObject(item.Message)
			if err != nil {
				return nil, err
			}
			id := stringValue(message["id"])
			if id == "" || len(id) > 160 {
				return nil, fail(400, "INVALID", "消息编号格式不正确")
			}
			if utf8.RuneCountInString(stringValue(message["text"])) > 200000 {
				return nil, fail(400, "INVALID", "消息过长")
			}
			if user {
				message["from"] = "you"
			} else {
				message["from"] = item.AgentID
			}
			if !hasMessage(messages, id) {
				messages = append(messages, message)
			}
		}
		room["messages"] = messages
		stripSecrets(document)
		clean, err := json.Marshal(document)
		if err != nil {
			return nil, err
		}
		if len(clean) > limit {
			return nil, fail(400, "INVALID", "聊天记录过大")
		}
		return clean, nil
	}
	return nil, fail(404, "ROOM_NOT_FOUND", "聊天记录里没有这个团队")
}
