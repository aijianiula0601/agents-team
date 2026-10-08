package com.chorus.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 只提供写入剪贴板，避免 WebView 权限限制，并且不读取用户已有剪贴板。 */
@CapacitorPlugin(name = "ChorusClipboard")
public class ChorusClipboardPlugin extends Plugin {
    @PluginMethod
    public void writeText(PluginCall call) {
        String value = call.getString("text");
        if (value == null || value.length() > 8 * 1024 * 1024) {
            call.reject("复制内容无效或过大");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) {
                    call.reject("系统剪贴板不可用");
                    return;
                }
                clipboard.setPrimaryClip(ClipData.newPlainText("Chorus", value));
                JSObject result = new JSObject();
                result.put("copied", true);
                call.resolve(result);
            } catch (RuntimeException error) {
                call.reject("复制失败，请重试");
            }
        });
    }
}
