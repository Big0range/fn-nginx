/**
 * Nginx 进程控制
 *
 * 命令形式（与 nginx-control 一致）：
 *   nginx -p <NGINX_P> -c <NGINX_C>             启动
 *   nginx -p <NGINX_P> -c <NGINX_C> -s quit     停止
 *   nginx -p <NGINX_P> -c <NGINX_C> -s reload   重载
 *
 * 注意：nginx 二进制为 Linux 版本，Windows 下仅能做参数/路径校验，
 * 实际执行会返回明确的错误信息。
 *
 * 约定：所有方法返回 Promise，已知错误设置 err.status，路由层转成 { message }。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { NGINX, NGINX_P, NGINX_C } = require('../config');

const EXEC_TIMEOUT = 15000;
const UI_IS_WIN = process.platform === 'win32';

// -p 的前缀必须以路径分隔符结尾，否则 nginx 拼接相对路径会出错
function prefixArg(dir) {
  return /[\\/]$/.test(dir) ? dir : dir + path.sep;
}

// pid 文件候选位置（nginx.conf 中 pid 指令相对 prefix 解析）
function pidFiles() {
  return [
    path.join(NGINX_P, 'logs', 'nginx.pid'),
    path.join(NGINX_P, 'run', 'nginx.pid'),
    path.join(NGINX_P, 'nginx.pid'),
  ];
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status || 500;
  return err;
}

function isWinHint(message) {
  return UI_IS_WIN ? message + '（当前为 Windows 环境，nginx 为 Linux 二进制，无法直接执行）' : message;
}

/* ------------------------------ 执行命令 ------------------------------ */

function run(args) {
  return new Promise(function (resolve, reject) {
    execFile(
      NGINX,
      args,
      { timeout: EXEC_TIMEOUT, maxBuffer: 1024 * 1024, windowsHide: true },
      function (err, stdout, stderr) {
        if (err) {
          const output = String(stderr || err.stderr || '').trim();
          let message;
          if (err.code === 'ENOENT') {
            message = fs.existsSync(NGINX)
              ? isWinHint('无法执行 nginx 二进制：' + NGINX)
              : '找不到 nginx 可执行文件：' + NGINX;
          } else if (err.code === 'EACCES' || err.code === 'EPERM') {
            message = isWinHint('没有执行权限或无法执行：' + NGINX);
          } else if (err.killed || err.signal) {
            message = '执行 nginx 命令超时（' + EXEC_TIMEOUT + 'ms）';
          } else {
            message = isWinHint(output || err.message || '执行 nginx 命令失败');
          }
          reject(fail(message, 500));
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

/* ------------------------------ 进程探测 ------------------------------ */

async function readPid() {
  const files = pidFiles();
  for (let i = 0; i < files.length; i++) {
    let raw;
    try {
      raw = await fs.promises.readFile(files[i], 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    const pid = parseInt(String(raw).trim(), 10);
    if (pid > 0) return { pid: pid, file: files[i] };
  }
  return null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 表示进程存在但没有操作权限
    return e.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function pollUntil(check, timeout, interval) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(interval || 100);
  }
  return !!(await check());
}

/* ------------------------------ 对外方法 ------------------------------ */

async function status() {
  const found = await readPid();
  if (!found) return { running: false, pid: null };
  if (!isAlive(found.pid)) return { running: false, pid: null };
  return { running: true, pid: found.pid };
}

async function start() {
  const current = await status();
  if (current.running) {
    throw fail('Nginx 已在运行（PID ' + current.pid + '）', 409);
  }

  if (!fs.existsSync(NGINX)) {
    throw fail('找不到 nginx 可执行文件：' + NGINX);
  }
  if (!fs.existsSync(NGINX_C)) {
    throw fail('找不到主配置文件：' + NGINX_C);
  }

  // 运行目录与日志目录是 pid 文件的前提
  await fs.promises.mkdir(NGINX_P, { recursive: true });
  await fs.promises.mkdir(path.join(NGINX_P, 'logs'), { recursive: true });

  await run(['-p', prefixArg(NGINX_P), '-c', NGINX_C]);

  const started = await pollUntil(async function () {
    return (await status()).running;
  }, 3000);

  if (!started) {
    throw fail('启动命令已执行，但未检测到 Nginx 进程，请检查 logs/error.log');
  }

  const after = await status();
  return { ok: true, pid: after.pid };
}

async function stop() {
  const current = await status();
  if (!current.running) {
    throw fail('Nginx 未运行', 409);
  }

  await run(['-p', prefixArg(NGINX_P), '-c', NGINX_C, '-s', 'quit']);

  const stopped = await pollUntil(async function () {
    return !(await status()).running;
  }, 5000);

  if (!stopped) {
    throw fail('已发送停止信号，但 Nginx 进程仍在运行（PID ' + current.pid + '）');
  }

  return { ok: true };
}

async function reload() {
  const current = await status();
  if (!current.running) {
    throw fail('Nginx 未运行', 409);
  }

  await run(['-p', prefixArg(NGINX_P), '-c', NGINX_C, '-s', 'reload']);
  return { ok: true };
}

module.exports = {
  status: status,
  start: start,
  stop: stop,
  reload: reload,
};
