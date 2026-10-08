package com.chorus.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.util.Log;
import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 验证已安装应用的照片与更新文件共享边界。
 * 参数：无，由 AndroidJUnitRunner 创建测试实例；返回值：无，断言失败即测试失败。
 * 注意事项：仅解析 Manifest 中的真实 provider 配置，不创建文件、不授予 URI 权限或启动安装器。
 */
@RunWith(AndroidJUnit4.class)
public class ChorusFileProviderInstrumentedTest {
    private static final String TAG = "ChorusFileProviderTest";

    /**
     * 验证照片 provider 保留 Capacitor 拍照所需的应用专属 Pictures 路径。
     * 参数：无；返回值：无，通过断言确认 URI 的协议、授权标识与路径。
     * 注意事项：文件无需存在，测试不会启动相机或读取已有照片。
     */
    @Test
    public void cameraProviderAllowsAppPictures() {
        // ------------ 验证照片共享路径 ---------------
        Log.i(TAG, "------------- 验证照片 provider 的 Pictures 路径 --------------");
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File pictures = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        assertNotNull("应用专属照片目录不可用", pictures);
        String authority = context.getPackageName() + ".fileprovider";
        Uri uri = FileProvider.getUriForFile(context, authority, new File(pictures, "provider-test.jpg"));
        assertEquals("content", uri.getScheme());
        assertEquals(authority, uri.getAuthority());
        assertEquals("/camera_images/provider-test.jpg", uri.getPath());
        Log.i(TAG, "照片 provider 的 Pictures 路径校验通过");
    }

    /**
     * 验证照片 provider 不再包含应用普通缓存目录。
     * 参数：无；返回值：无，必须抛出 IllegalArgumentException 才通过测试。
     * 注意事项：只验证 URI 映射拒绝，不创建或读取缓存文件。
     */
    @Test(expected = IllegalArgumentException.class)
    public void cameraProviderRejectsOrdinaryCache() {
        // ------------ 验证普通缓存隔离 ---------------
        Log.i(TAG, "------------- 验证照片 provider 拒绝普通缓存 --------------");
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File cacheFile = new File(context.getCacheDir(), "provider-test.txt");
        FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", cacheFile);
    }

    /**
     * 验证照片 provider 不能替代更新 provider 共享 APK 缓存。
     * 参数：无；返回值：无，必须抛出 IllegalArgumentException 才通过测试。
     * 注意事项：测试使用虚拟文件路径，不触碰已下载的更新包。
     */
    @Test(expected = IllegalArgumentException.class)
    public void cameraProviderRejectsUpdateCache() {
        // ------------ 验证更新缓存隔离 ---------------
        Log.i(TAG, "------------- 验证照片 provider 拒绝更新缓存 --------------");
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File updateFile = new File(context.getCacheDir(), "updates/provider-test.apk");
        FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", updateFile);
    }

    /**
     * 验证专用更新 provider 仍能为 updates 目录中的 APK 产生 URI。
     * 参数：无；返回值：无，通过断言确认更新 URI 的协议、授权标识与路径。
     * 注意事项：只验证路径兼容性；安装器的只读授权继续由 ChorusUpdatesPlugin 的安装流程负责。
     */
    @Test
    public void updateProviderAllowsUpdateCache() {
        // ------------ 验证更新共享路径 ---------------
        Log.i(TAG, "------------- 验证更新 provider 的 APK 路径 --------------");
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String authority = context.getPackageName() + ".updates.fileprovider";
        File updateFile = new File(context.getCacheDir(), "updates/provider-test.apk");
        Uri uri = FileProvider.getUriForFile(context, authority, updateFile);
        assertEquals("content", uri.getScheme());
        assertEquals(authority, uri.getAuthority());
        assertEquals("/update_packages/provider-test.apk", uri.getPath());
        Log.i(TAG, "更新 provider 的 APK 路径校验通过");
    }
}
