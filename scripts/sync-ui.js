#!/usr/bin/env node
/**
 * 将 shared/web 同步到 mac-app/renderer 与 android-app/www。
 * 功能：复制 UI 资源，保证双端使用同一套工作台实现。
 * 参数：无
 * 返回值：process exit code
 * 注意事项：会覆盖目标目录中的同名文件。
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "shared", "web");
const targets = [
  path.join(root, "mac-app", "renderer"),
  path.join(root, "android-app", "www"),
];

/**
 * 递归确保目录存在。
 * @param {string} dir 目录路径
 * @returns {void}
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 将源目录文件复制到目标目录。
 * @param {string} from 源目录
 * @param {string} to 目标目录
 * @returns {string[]} 已复制文件名列表
 */
function copyDir(from, to) {
  ensureDir(to);
  const copied = [];
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copied.push(...copyDir(src, dest).map((n) => path.join(name, n)));
    } else {
      fs.copyFileSync(src, dest);
      copied.push(name);
    }
  }
  return copied;
}

for (const target of targets) {
  const files = copyDir(srcDir, target);
  console.log(`[sync-ui] ${path.relative(root, target)} <- ${files.join(", ")}`);
}
