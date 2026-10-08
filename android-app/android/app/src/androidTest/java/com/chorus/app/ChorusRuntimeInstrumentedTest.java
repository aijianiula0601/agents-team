package com.chorus.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.view.ViewCapture;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 验证实际 Android WebView 与 Java HTTP 桥；只读页面结构，不自动点击或输入用户界面。
 * 连接令牌仅通过 instrumentation runner 参数传入内存，不写源码、日志或应用设置。
 */
@RunWith(AndroidJUnit4.class)
public class ChorusRuntimeInstrumentedTest {
    @Test
    public void packagedWebViewLoadsTeamAndTerminalRuntime() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.chorus.app", context.getPackageName());
        String version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitRuntime(scenario);
            JSONObject state = evaluate(scenario,
                    "({platform:document.documentElement.dataset.platform,"
                            + "title:document.title,"
                            + "deskVisible:document.querySelector('.desk').getBoundingClientRect().width>0,"
                            + "composerVisible:document.querySelector('#composerInput').getBoundingClientRect().height>0,"
                            + "agents:document.querySelector('#agentList').children.length,"
                            + "teams:document.querySelector('#roomList').children.length,"
                            + "terminal:typeof ChorusTerminalUI.open==='function',"
                            + "gateway:typeof ChorusGatewayClient.request==='function',"
                            + "xterm:typeof Terminal==='function'&&typeof FitAddon.FitAddon==='function',"
                            + "nativeHttp:typeof Capacitor.Plugins.CapacitorHttp.request==='function',"
                            + "scripts:Array.from(document.scripts).map(s=>s.getAttribute('src')||'')})");
            assertEquals("android", state.getString("platform"));
            assertTrue(state.getString("title").contains("Chorus"));
            assertTrue(state.getBoolean("deskVisible"));
            assertTrue(state.getBoolean("composerVisible"));
            assertTrue(state.getInt("agents") > 0);
            assertTrue(state.getInt("teams") > 0);
            for (String key : new String[] {"terminal", "gateway", "xterm", "nativeHttp"}) {
                assertTrue("运行时模块未加载：" + key, state.getBoolean(key));
            }
            JSONArray scripts = state.getJSONArray("scripts");
            for (String file : new String[] {"conversation.js", "model-client.js", "gateway-client.js", "terminal-ui.js", "app.js", "platform.js", "vendor/xterm.js", "vendor/addon-fit.js"}) {
                boolean found = false;
                for (int index = 0; index < scripts.length(); index++) {
                    if (scripts.getString(index).equals(file + "?v=" + version)) found = true;
                }
                assertTrue("APK 页面与版本资源不一致：" + file, found);
            }
            capturePackagedPage(scenario, context, version);
        }
    }

    @Test
    public void capacitorJavaHttpAndGatewayClientReachMac() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        String token = arguments.getString("chorusToken", "");
        assertTrue("请通过 runner 参数 chorusToken 提供本次临时网关令牌", token.matches("[a-f0-9]{64}"));
        String baseUrl = arguments.getString("chorusBaseUrl", "http://127.0.0.1:4176");
        String config = new JSONObject().put("baseUrl", baseUrl).put("token", token).toString();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitRuntime(scenario);
            // 原生 plugin 与实际页面公共客户端分别调用同一只读端点，验证完整 Java/JS 链路。
            JSONObject result = invoke(scenario,
                    "(async()=>{const config=" + config + ";"
                            + "const raw=await Capacitor.Plugins.CapacitorHttp.request({url:config.baseUrl+'/info',method:'GET',"
                            + "headers:{Authorization:'Bearer '+config.token},responseType:'text',connectTimeout:5000,readTimeout:10000});"
                            + "const native=typeof raw.data==='string'?JSON.parse(raw.data):raw.data;"
                            + "const info=await ChorusGatewayClient.request(config,'GET','/info');"
                            + "const snapshot=await ChorusGatewayClient.request(config,'GET','/config');"
                            + "return {nativeStatus:raw.status,nativeName:native.name,name:info.name,version:info.version,"
                            + "protocol:info.protocolVersion,terminal:info.capabilities.terminal,execution:info.capabilities.execution,"
                            + "agents:snapshot.agents.length,hasCli:snapshot.agents.some(a=>['codex','cursor','claude'].includes(a.backend))};})()");
            assertEquals(200, result.getInt("nativeStatus"));
            assertEquals("Chorus", result.getString("nativeName"));
            assertEquals("Chorus", result.getString("name"));
            assertEquals("0.4.0", result.getString("version"));
            assertEquals(1, result.getInt("protocol"));
            assertTrue(result.getBoolean("terminal"));
            assertTrue(result.getBoolean("execution"));
            assertTrue(result.getInt("agents") > 0);
            assertTrue(result.getBoolean("hasCli"));
        }
    }

    @Test
    public void nativeGatewayRejectsInvalidTokenWithoutLeakingIt() throws Exception {
        String baseUrl = InstrumentationRegistry.getArguments().getString("chorusBaseUrl", "http://127.0.0.1:4176");
        String config = new JSONObject().put("baseUrl", baseUrl).put("token", new String(new char[64]).replace('\0', '0')).toString();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitRuntime(scenario);
            JSONObject result = invoke(scenario,
                    "(async()=>{const config=" + config + ";try{await ChorusGatewayClient.request(config,'GET','/info');"
                            + "return {rejected:false};}catch(error){return {rejected:true,status401:error.message.includes('HTTP 401'),"
                            + "tokenVisible:error.message.includes(config.token)};}})()");
            assertTrue(result.getBoolean("rejected"));
            assertTrue(result.getBoolean("status401"));
            assertFalse(result.getBoolean("tokenVisible"));
        }
    }

    private static void awaitRuntime(ActivityScenario<MainActivity> scenario) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            JSONObject state = evaluate(scenario,
                    "({ready:document.readyState==='complete'&&typeof ChorusGatewayClient==='object'"
                            + "&&typeof ChorusTerminalUI==='object'&&typeof Capacitor==='object'"
                            + "&&Capacitor.getPlatform()==='android'&&!!document.querySelector('#composerInput')})");
            if (state.optBoolean("ready")) return;
            Thread.sleep(100);
        }
        fail("Android WebView 在 30 秒内没有完成 Chorus 页面与原生桥加载");
    }

    private static void capturePackagedPage(ActivityScenario<MainActivity> scenario, Context context, String version) throws Exception {
        // ATD 默认关闭绘制；AndroidX 仅在截图期间启用并自动恢复，不修改正式 APK 的渲染设置。
        invoke(scenario, "(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {ready:true};})()");
        AtomicReference<ListenableFuture<Bitmap>> pending = new AtomicReference<>();
        scenario.onActivity(activity -> pending.set(ViewCapture.captureToBitmap(activity.getBridge().getWebView())));
        Bitmap bitmap = pending.get().get(30, TimeUnit.SECONDS);
        assertTrue("真实 WebView 截图尺寸无效", bitmap.getWidth() > 0 && bitmap.getHeight() > 0);
        Set<Integer> colors = new HashSet<>();
        for (int y = 0; y < bitmap.getHeight(); y += Math.max(1, bitmap.getHeight() / 80)) {
            for (int x = 0; x < bitmap.getWidth(); x += Math.max(1, bitmap.getWidth() / 40)) {
                colors.add(bitmap.getPixel(x, y));
            }
        }
        assertTrue("ATD 没有绘制真实页面，截图仍为空白", colors.size() > 20);
        File directory = context.getExternalFilesDir(null);
        assertNotNull("截图目录不可用", directory);
        try (FileOutputStream output = new FileOutputStream(new File(directory, "chorus-android-" + version + ".png"))) {
            assertTrue("截图 PNG 编码失败", bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally {
            bitmap.recycle();
        }
    }

    private static JSONObject invoke(ActivityScenario<MainActivity> scenario, String expression) throws Exception {
        evaluate(scenario, "(()=>{window.__chorusRuntimeAcceptance=null;Promise.resolve(" + expression + ")"
                + ".then(value=>window.__chorusRuntimeAcceptance={done:true,ok:true,value})"
                + ".catch(()=>window.__chorusRuntimeAcceptance={done:true,ok:false});return {started:true};})()");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            JSONObject state = evaluate(scenario, "window.__chorusRuntimeAcceptance||({done:false})");
            if (state.optBoolean("done")) {
                assertTrue("Android 原生 HTTP/网关请求失败，请检查临时 fixture 与 adb reverse", state.optBoolean("ok"));
                return state.getJSONObject("value");
            }
            Thread.sleep(100);
        }
        fail("Android 原生 HTTP/网关请求在 30 秒内没有完成");
        return null;
    }

    private static JSONObject evaluate(ActivityScenario<MainActivity> scenario, String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            assertNotNull("MainActivity 原生桥不存在", activity.getBridge());
            activity.getBridge().getWebView().evaluateJavascript("JSON.stringify((" + expression + "))", value -> {
                result.set(value);
                completed.countDown();
            });
        });
        assertTrue("WebView JS 结果等待超时", completed.await(10, TimeUnit.SECONDS));
        Object decoded = new JSONTokener(result.get()).nextValue();
        assertTrue("WebView JS 没有返回有效 JSON 对象", decoded instanceof String);
        return new JSONObject((String) decoded);
    }
}
