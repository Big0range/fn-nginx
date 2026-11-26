var express = require('express');
var fs = require('fs');
var path = require('path');
var config = require('../config');
var nginx = require('../utils/nginx');

var router = express.Router();

var CONF_DIR = config.NGINX_D;

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

    res.json({ files: files });
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
    var content = req.body && typeof req.body.content === 'string' ? req.body.content : '';

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
