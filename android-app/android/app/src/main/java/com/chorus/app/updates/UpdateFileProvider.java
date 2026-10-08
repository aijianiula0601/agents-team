package com.chorus.app.updates;

import androidx.core.content.FileProvider;

/**
 * 更新安装包专用文件提供器。
 * 功能：为系统安装器提供只读 APK URI，与应用现有 FileProvider 使用不同组件和路径权限。
 * 参数：由 Android 根据 Manifest 创建；返回值：无。
 * 注意事项：仅共享私有 updates 缓存目录，禁止导出和外部路径访问。
 */
public class UpdateFileProvider extends FileProvider {}
