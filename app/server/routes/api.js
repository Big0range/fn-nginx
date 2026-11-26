var express = require('express');
var fs = require('fs');
var path = require('path');
var config = require('../config');
var nginx = require('../utils/nginx');

var router = express.Router();

// 接口数据都要求实时，禁用缓存避免 304 空响应
router.use(function (req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
});

var CONF_DIR = config.NGINX_D;
var MAIN_CONF = config.NGINX_C;

var NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,120}\.conf$/i;

function checkName(raw) {
  var name = String(raw || '');
  if (!NAME_RE.test(name) || name.indexOf('..') !== -1) {
    var err = new Error('非法的配置文件名：' + name);
    err.status = 400;
    throw err;
  }
  return name;
}

function notFound(name) {
  var err = new Error('配置文件不存在：' + name);
  err.status = 404;
  return err;
}

function isConf(name) {
  return name.charAt(0) !== '.' && /\.conf$/i.test(name);
}

// 只接受字符串 content，避免请求体异常时把文件清空
function readContent(req) {
  if (!req.body || typeof req.body.content !== 'string') {
    var err = new Error('请求体缺少 content 字段');
    err.status = 400;
    throw err;
  }
  return req.body.content;
}

function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/* ------------------------------ 配置文件 CRUD ------------------------------ */

// 列出 conf.d 下的配置文件
router.get(
  '/configs',
  wrap(async function (req, res) {
    var dir = CONF_DIR;
    await fs.promises.mkdir(dir, { recursive: true });
    var names = (await fs.promises.readdir(dir)).filter(isConf);

    var files = [];
    for (var i = 0; i < names.length; i++) {
      try {
        var st = await fs.promises.stat(path.join(dir, names[i]));
        if (st.isFile()) {
          files.push({
            name: names[i],
            size: st.size,
            mtime: st.mtime.toISOString(),
          });
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }

    files.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    // 主配置 nginx.conf 单独返回，供页面置顶展示
    var main = null;
    try {
      var mainStat = await fs.promises.stat(MAIN_CONF);
      if (mainStat.isFile()) {
        main = {
          name: path.basename(MAIN_CONF),
          size: mainStat.size,
          mtime: mainStat.mtime.toISOString(),
        };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    res.json({ files: files, main: main });
  })
);

/* ------------------------------ 主配置 nginx.conf ------------------------------ */

// 读取主配置（不可新建、不可删除）
router.get(
  '/main-config',
  wrap(async function (req, res) {
    var content;
    try {
      content = await fs.promises.readFile(MAIN_CONF, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('nginx.conf');
      throw e;
    }
    res.json({ name: path.basename(MAIN_CONF), content: content });
  })
);

// 保存主配置
router.put(
  '/main-config',
  wrap(async function (req, res) {
    var content = readContent(req);
    await fs.promises.mkdir(path.dirname(MAIN_CONF), { recursive: true });
    await fs.promises.writeFile(MAIN_CONF, content, 'utf8');
    res.json({ ok: true, name: path.basename(MAIN_CONF), size: Buffer.byteLength(content, 'utf8') });
  })
);

// 读取单个配置文件
router.get(
  '/configs/:name',
  wrap(async function (req, res) {
    var name = checkName(req.params.name);
    var file = path.join(CONF_DIR, name);

    var content;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound(name);
      throw e;
    }

    res.json({ name: name, content: content });
  })
);

// 新建或覆盖配置文件
router.put(
  '/configs/:name',
  wrap(async function (req, res) {
    var name = checkName(req.params.name);
    var dir = CONF_DIR;
    var file = path.join(dir, name);
    var content = readContent(req);

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, content, 'utf8');

    res.json({ ok: true, name: name, size: Buffer.byteLength(content, 'utf8') });
  })
);

// 删除配置文件
router.delete(
  '/configs/:name',
  wrap(async function (req, res) {
    var name = checkName(req.params.name);
    var file = path.join(CONF_DIR, name);

    try {
      await fs.promises.unlink(file);
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound(name);
      throw e;
    }

    res.json({ ok: true, name: name });
  })
);

/* ------------------------------ Nginx 进程控制 ------------------------------ */
/* 以下接口的具体实现见 app/server/utils/nginx.js（当前为占位，待补充）       */

router.get(
  '/status',
  wrap(async function (req, res) {
    res.json(await nginx.status());
  })
);

router.get(
  '/load',
  wrap(async function (req, res) {
    res.json(await nginx.load());
  })
);

router.get(
  '/performance',
  wrap(async function (req, res) {
    res.json(await nginx.performance());
  })
);

router.put(
  '/performance',
  wrap(async function (req, res) {
    var values = req.body && req.body.values;
    res.json(await nginx.updatePerformance(values));
  })
);

router.post(
  '/start',
  wrap(async function (req, res) {
    res.json(await nginx.start());
  })
);

router.post(
  '/stop',
  wrap(async function (req, res) {
    res.json(await nginx.stop());
  })
);

router.post(
  '/reload',
  wrap(async function (req, res) {
    res.json(await nginx.reload());
  })
);

/* --------------------------------- 兜底 --------------------------------- */

router.use(function (req, res) {
  res.status(404).json({ message: '接口不存在：' + req.method + ' ' + req.originalUrl });
});

// 统一以 JSON 返回错误，前端直接展示 message
router.use(function (err, req, res, next) {
  var status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: err.message || '服务器内部错误' });
});

module.exports = router;
