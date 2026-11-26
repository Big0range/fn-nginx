/**
 * Nginx 进程控制
 *
 * 命令形式（与 nginx-control 一致）：
 *   nginx -p <NGINX_P> -c <NGINX_C>             启动
 *   nginx -p <NGINX_P> -c <NGINX_C> -s stop     强制停止
 *   nginx -p <NGINX_P> -c <NGINX_C> -s reload   重载
 *
 * 注意：nginx 二进制为 Linux 版本，Windows 下仅能做参数/路径校验，
 * 实际执行会返回明确的错误信息。
 *
 * 约定：所有方法返回 Promise，已知错误设置 err.status，路由层转成 { message }。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { NGINX, NGINX_P, NGINX_C, NGINX_D } = require('../config');

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

/* ------------------------------ 版本号 ------------------------------ */

// 无法执行二进制时（如 Windows 开发环境）从二进制文件中提取版本字符串
async function versionFromBinary() {
  try {
    const buf = await fs.promises.readFile(NGINX, 'latin1');
    const hit = buf.match(/nginx\/(\d+\.\d+\.\d+[\w.\-]*)/i);
    return hit ? hit[1] : null;
  } catch (e) {
    return null;
  }
}

let versionPromise = null;

function getVersion() {
  if (!versionPromise) {
    versionPromise = run(['-v'])
      .then(function (result) {
        const text = String(result.stderr || '') + '\n' + String(result.stdout || '');
        const hit = text.match(/nginx\/([\w.\-]+)/i);
        return hit ? hit[1] : null;
      })
      .catch(versionFromBinary);
  }
  return versionPromise;
}

/* ------------------------------ 负载统计 ------------------------------ */

function execCommand(cmd, args, timeout) {
  return new Promise(function (resolve, reject) {
    execFile(
      cmd,
      args,
      { timeout: timeout || 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      function (err, stdout) {
        if (err) reject(err);
        else resolve(String(stdout || ''));
      }
    );
  });
}

function isConfFile(name) {
  return name.charAt(0) !== '.' && /\.conf$/i.test(name);
}

// 读取主配置 + conf.d，用于定位 stub_status 的端口与路径
function configText() {
  var parts = [];
  try {
    parts.push(fs.readFileSync(NGINX_C, 'utf8'));
  } catch (e) {}
  try {
    fs.readdirSync(NGINX_D)
      .filter(isConfFile)
      .forEach(function (name) {
        try {
          parts.push(fs.readFileSync(path.join(NGINX_D, name), 'utf8'));
        } catch (e) {}
      });
  } catch (e) {}
  return parts.join('\n');
}

function stubUrls() {
  if (process.env.NGINX_STUB_URL) return [process.env.NGINX_STUB_URL];

  var text = configText();
  if (!/\bstub_status\b/.test(text)) return [];

  var stubPath = "/nginx_status";
  var found = text.match(/location\s+(?:=\s*)?(\/[^\s{;]+)\s*\{[^}]*\bstub_status\b/);
  if (found && /^\/[A-Za-z0-9._\-\/]+$/.test(found[1])) stubPath = found[1];

  var ports = [];
  var re = /^\s*listen\s+([^\s;]+)/gm;
  var m;
  while ((m = re.exec(text))) {
    var hit = m[1].match(/(\d{1,5})\s*$/);
    if (hit && ports.indexOf(hit[1]) === -1) ports.push(hit[1]);
  }
  if (!ports.length) ports.push("80");

  return ports.map(function (port) {
    return "http://127.0.0.1:" + port + stubPath;
  });
}

function httpGet(url, timeout) {
  return new Promise(function (resolve) {
    var settled = false;
    function done(value) {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }
    var req = http.get(url, { timeout: timeout || 1500 }, function (res) {
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) {
        body += chunk;
      });
      res.on("end", function () {
        done(res.statusCode === 200 ? body : null);
      });
      res.on("error", function () {
        done(null);
      });
    });
    req.on("timeout", function () {
      req.destroy();
      done(null);
    });
    req.on("error", function () {
      done(null);
    });
  });
}

function parseStubStatus(text) {
  var m = text.match(
    /Active connections:\s*(\d+)[\s\S]*?server accepts handled requests\s*([\d\s]+)[\s\S]*?Reading:\s*(\d+)\s*Writing:\s*(\d+)\s*Waiting:\s*(\d+)/i
  );
  if (!m) return null;
  var totals = m[2].trim().split(/\s+/).map(Number);
  if (totals.length < 3) return null;
  return {
    active: Number(m[1]),
    accepts: totals[0],
    handled: totals[1],
    requests: totals[2],
    reading: Number(m[3]),
    writing: Number(m[4]),
    waiting: Number(m[5]),
  };
}

async function readStubStatus() {
  var urls = stubUrls();
  for (var i = 0; i < urls.length; i++) {
    var body = await httpGet(urls[i], 1500);
    if (body) {
      var parsed = parseStubStatus(body);
      if (parsed) return parsed;
    }
  }
  return null;
}

// worker 进程数量 / CPU / 常驻内存（Linux 通过 ps 采集）
async function readWorkers() {
  if (process.platform === "win32") return null;

  var output;
  try {
    output = await execCommand("ps", ["-eo", "pcpu=,rss=,args="], 4000);
  } catch (e) {
    return null;
  }

  var workers = 0;
  var cpu = 0;
  var rss = 0;
  output.split("\n").forEach(function (line) {
    if (line.indexOf("nginx: worker process") === -1) return;
    var parts = line.trim().split(/\s+/);
    var c = parseFloat(parts[0]);
    var kb = parseInt(parts[1], 10);
    if (!isNaN(c)) cpu += c;
    if (!isNaN(kb)) rss += kb;
    workers++;
  });

  return {
    workers: workers,
    cpu: Math.round(cpu * 10) / 10,
    memory: Math.round(rss / 1024),
  };
}

async function load() {
  const results = await Promise.all([readStubStatus(), readWorkers()]);
  return { stub: results[0], process: results[1] };
}

/* ------------------------------ 性能参数 ------------------------------ */

// 未显式配置时展示 nginx 默认值
var PERF_DEFAULTS = {
  worker_processes: "1",
  worker_connections: "512",
  keepalive_timeout: "75",
  gzip: "off",
  gzip_min_length: "20",
  gzip_comp_level: "1",
  client_max_body_size: "1m",
  server_names_hash_bucket_size: "32",
  client_header_buffer_size: "1k",
  client_body_buffer_size: "8k",
};

function findDirective(text, key) {
  var re = new RegExp("^[ \\t]*" + key + "[ \\t]+([^;{]+)", "m");
  var m = text.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function readMainConfig() {
  try {
    return fs.readFileSync(NGINX_C, "utf8");
  } catch (e) {
    return "";
  }
}

async function performance() {
  var text = readMainConfig();
  var items = Object.keys(PERF_DEFAULTS).map(function (key) {
    var value = findDirective(text, key);
    return {
      key: key,
      value: value || PERF_DEFAULTS[key],
      isDefault: !value,
    };
  });
  return { items: items };
}

// 每个参数允许的取值与需要写入的配置块
var PERF_RULES = {
  worker_processes: { context: "main", pattern: /^(auto|[1-9][0-9]{0,2})$/i },
  worker_connections: { context: "events", pattern: /^[1-9][0-9]{0,6}$/ },
  keepalive_timeout: { context: "http", pattern: /^[1-9][0-9]{0,5}(?:[ \t]+[1-9][0-9]{0,5})?$/ },
  gzip: { context: "http", pattern: /^(on|off)$/i },
  gzip_min_length: { context: "http", pattern: /^[0-9]+[kKmM]?$/ },
  gzip_comp_level: { context: "http", pattern: /^[1-9]$/ },
  client_max_body_size: { context: "http", pattern: /^[0-9]+[kKmMgG]?$/ },
  server_names_hash_bucket_size: { context: "http", pattern: /^[1-9][0-9]{0,5}$/ },
  client_header_buffer_size: { context: "http", pattern: /^[0-9]+[kKmM]?$/ },
  client_body_buffer_size: { context: "http", pattern: /^[0-9]+[kKmM]?$/ },
};

// 扫描顶层块（跳过注释与引号内容），返回 { name, start, open }
function scanTopBlocks(text) {
  var blocks = [];
  var depth = 0;
  var word = "";
  var wordStart = -1;
  var inComment = false;
  var quote = null;
  var i = 0;

  while (i < text.length) {
    var ch = text[i];

    if (inComment) {
      if (ch === "\n") inComment = false;
      i++;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "#") {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }

    if (depth === 0) {
      if (/[A-Za-z0-9_]/.test(ch)) {
        if (!word) wordStart = i;
        word += ch;
        i++;
        continue;
      }
      if (ch === "{") {
        if (word) blocks.push({ name: word, start: wordStart, open: i });
        depth++;
        word = "";
        i++;
        continue;
      }
      if (ch === "}") {
        if (depth > 0) depth--;
        word = "";
        i++;
        continue;
      }
      if (ch === ";") {
        word = "";
        i++;
        continue;
      }
      if (!/\s/.test(ch)) word = "";
      i++;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }

  return blocks;
}

function replaceDirective(text, key, value) {
  var re = new RegExp("^([ \\t]*" + key + "[ \\t]+)[^;\\n]*;", "m");
  if (!re.test(text)) return { text: text, replaced: false };
  return {
    text: text.replace(re, function (match, lead) {
      return lead + value + ";";
    }),
    replaced: true,
  };
}

function insertDirective(text, context, key, value) {
  var blocks = scanTopBlocks(text);
  var line = key + " " + value + ";";

  if (context === "main") {
    var anchor = null;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].name === "events" || blocks[i].name === "http" || blocks[i].name === "stream") {
        anchor = blocks[i];
        break;
      }
    }
    if (anchor) return text.slice(0, anchor.start) + line + "\n\n" + text.slice(anchor.start);
    return line + "\n\n" + text;
  }

  for (var j = 0; j < blocks.length; j++) {
    if (blocks[j].name === context) {
      var open = blocks[j].open;
      return text.slice(0, open + 1) + "\n    " + line + text.slice(open + 1);
    }
  }
  return null;
}

async function updatePerformance(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    var err = new Error("请求体缺少 values 对象");
    err.status = 400;
    throw err;
  }

  var keys = Object.keys(values);
  if (!keys.length) {
    var empty = new Error("没有需要修改的参数");
    empty.status = 400;
    throw empty;
  }

  var text = readMainConfig();
  if (!text) {
    var readErr = new Error("无法读取主配置：" + NGINX_C);
    readErr.status = 500;
    throw readErr;
  }

  keys.forEach(function (key) {
    var rule = PERF_RULES[key];
    if (!rule) {
      var unknown = new Error("不支持的参数：" + key);
      unknown.status = 400;
      throw unknown;
    }
    var value = String(values[key]).trim();
    if (!rule.pattern.test(value)) {
      var invalid = new Error(key + " 取值不合法：" + value);
      invalid.status = 400;
      throw invalid;
    }
  });

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = String(values[key]).trim();
    var result = replaceDirective(text, key, value);
    text = result.text;
    if (!result.replaced) {
      var next = insertDirective(text, PERF_RULES[key].context, key, value);
      if (next === null) {
        var missing = new Error("未找到 " + PERF_RULES[key].context + " 配置块，无法写入 " + key);
        missing.status = 400;
        throw missing;
      }
      text = next;
    }
  }

  await fs.promises.writeFile(NGINX_C, text, "utf8");
  return performance();
}

/* ------------------------------ 对外方法 ------------------------------ */

async function status() {
  const version = await getVersion();
  const found = await readPid();
  if (!found) return { running: false, pid: null, version: version };
  if (!isAlive(found.pid)) return { running: false, pid: null, version: version };
  return { running: true, pid: found.pid, version: version };
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

  // 强制停止（SIGTERM），不等待活跃请求
  await run(['-p', prefixArg(NGINX_P), '-c', NGINX_C, '-s', 'stop']);

  let stopped = await pollUntil(async function () {
    return !(await status()).running;
  }, 3000);

  // 仍未退出则直接 SIGKILL
  if (!stopped && current.pid) {
    try {
      process.kill(current.pid, 'SIGKILL');
    } catch (e) {}
    stopped = await pollUntil(async function () {
      return !(await status()).running;
    }, 2000);
  }

  if (!stopped) {
    throw fail('Nginx 进程无法终止（PID ' + current.pid + '），请检查 logs/error.log');
  }

  // 进程已退出，清理可能残留的 pid 文件，避免下次误判为运行中
  const files = pidFiles();
  for (let i = 0; i < files.length; i++) {
    try {
      await fs.promises.unlink(files[i]);
    } catch (e) {}
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
  load: load,
  performance: performance,
  updatePerformance: updatePerformance,
};
