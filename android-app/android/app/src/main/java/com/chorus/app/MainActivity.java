package com.chorus.app;

import android.os.Bundle;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.BridgeActivity;
import com.chorus.app.updates.ChorusUpdatesPlugin;

/**
 * Chorus Android 主界面。
 * 功能：启动 Web 群聊界面并注册原生复制能力。
 * Google 授权使用系统浏览器和中转站回调，页面通过安全轮询领取登录会话。
 */
public class MainActivity extends BridgeActivity {
    /** 避免旧 WebView 在创建团队或对话时因缺少标准 API 而白屏。 */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChorusClipboardPlugin.class);
        registerPlugin(ChorusUpdatesPlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge != null && !bridge.isMinimumWebViewInstalled()) {
            new AlertDialog.Builder(this)
                    .setTitle("需要更新系统 WebView")
                    .setMessage("Chorus 的交互终端需要 Android System WebView 或 Chrome 109 及以上版本。请在应用商店更新后重新打开 Chorus。")
                    .setPositiveButton("关闭应用", (dialog, which) -> finish())
                    .setCancelable(false)
                    .show();
        }
    }

}
