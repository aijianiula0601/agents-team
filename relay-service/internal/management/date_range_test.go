package management

import (
	"encoding/json"
	"net/url"
	"testing"
	"time"
)

// TestOverviewDateRange 验证UTC日界线和输入边界。参数：t为测试句柄；返回值：无；注意事项：固定当前时间，覆盖闰日、366天上限及重复参数。
func TestOverviewDateRange(t *testing.T) {
	now := time.Date(2026, 10, 3, 3, 0, 0, 0, time.FixedZone("Asia/Shanghai", 8*3600))
	cases := []struct {
		name, query, start, end string
		invalid                 bool
	}{
		{name: "默认最近30个UTC日", start: "2026-09-03", end: "2026-10-02"},
		{name: "单日含首尾", query: "startDate=2026-10-02&endDate=2026-10-02", start: "2026-10-02", end: "2026-10-02"},
		{name: "闰年日期", query: "startDate=2024-02-28&endDate=2024-03-01", start: "2024-02-28", end: "2024-03-01"},
		{name: "366天允许", query: "startDate=2025-10-02&endDate=2026-10-02", start: "2025-10-02", end: "2026-10-02"},
		{name: "367天拒绝", query: "startDate=2025-10-01&endDate=2026-10-02", invalid: true},
		{name: "开始日期缺失", query: "endDate=2026-10-02", invalid: true},
		{name: "结束日期缺失", query: "startDate=2026-10-02", invalid: true},
		{name: "显式空日期", query: "startDate=&endDate=", invalid: true},
		{name: "日期颠倒", query: "startDate=2026-10-02&endDate=2026-10-01", invalid: true},
		{name: "本地今日仍是UTC未来", query: "startDate=2026-10-02&endDate=2026-10-03", invalid: true},
		{name: "无效闰日", query: "startDate=2025-02-29&endDate=2025-03-01", invalid: true},
		{name: "不支持时间戳", query: "startDate=2026-10-01T00:00:00Z&endDate=2026-10-02", invalid: true},
		{name: "月份必须补零", query: "startDate=2026-9-01&endDate=2026-10-02", invalid: true},
		{name: "超出MySQL日期范围", query: "startDate=0001-01-01&endDate=0001-01-02", invalid: true},
		{name: "重复日期参数", query: "startDate=2026-10-01&startDate=2026-10-02&endDate=2026-10-02", invalid: true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			query, err := url.ParseQuery(item.query)
			if err != nil {
				t.Fatal(err)
			}
			start, end, err := overviewDateRange(query, now)
			if item.invalid {
				if err == nil {
					t.Fatal("非法日期范围被接受")
				}
				return
			}
			if err != nil || start.Format("2006-01-02") != item.start || end.Format("2006-01-02") != item.end || start.Location() != time.UTC || end.Location() != time.UTC {
				t.Fatalf("日期范围不符合UTC口径 start=%v end=%v err=%v", start, end, err)
			}
		})
	}
}

// TestOverviewRangeHTTP 验证日期参数通过认证后进入存储且保持账号隔离。参数：t为测试句柄；返回值：无；注意事项：无效范围不应执行任何统计查询。
func TestOverviewRangeHTTP(t *testing.T) {
	handler, store, _ := setupAdmin(t)
	created := request(handler, "POST", "/relay/admin/api/auth/register", `{"email":"trend@example.test","password":"trend-password"}`, nil, "")
	if created.Code != 200 {
		t.Fatal(created.Code, created.Body.String())
	}
	cookie, session := loginTest(t, handler, "trend@example.test", "trend-password")
	w := request(handler, "GET", "/relay/admin/api/overview?startDate=2024-02-28&endDate=2024-03-01&accountId=other", "", cookie, "")
	if w.Code != 200 || store.scope != session.User.ID || store.start.Format("2006-01-02") != "2024-02-28" || store.end.Format("2006-01-02") != "2024-03-01" {
		t.Fatal("日期范围或账号隔离错误", w.Code, w.Body.String())
	}
	var payload struct {
		Range struct {
			Start string `json:"startDate"`
			End   string `json:"endDate"`
			Days  int    `json:"days"`
		} `json:"range"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil || payload.Range.Start != "2024-02-28" || payload.Range.End != "2024-03-01" || payload.Range.Days != 3 {
		t.Fatal("响应缺少准确的日期口径", w.Body.String())
	}
	w = request(handler, "GET", "/relay/admin/api/overview", "", cookie, "")
	if w.Code != 200 || store.end.Sub(store.start) != 29*24*time.Hour {
		t.Fatal("默认范围不是30天", w.Code)
	}
	for _, query := range []string{"startDate=2026-01-01", "startDate=2024-01-01&endDate=2025-01-01", "startDate=9999-01-01&endDate=9999-01-02"} {
		store.start, store.end = time.Time{}, time.Time{}
		w = request(handler, "GET", "/relay/admin/api/overview?"+query, "", cookie, "")
		if w.Code != 400 || !store.start.IsZero() || !store.end.IsZero() {
			t.Fatal("无效日期执行了统计查询", query, w.Code)
		}
	}
}
