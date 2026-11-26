var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var apiRouter = require('./routes/api');
/**
 * ./app/server/nginx/sbin/nginx -p "$(pwd)/app/server/nginx/" -c conf/nginx.conf -s reload
 */
var app = express();

const nginxUtils = require('./utils/nginx');
function initNginx() {
  const NGINX_BASE_VAR = process.env.TRIM_PKGVAR ? path.resolve(process.env.TRIM_PKGVAR, 'nginx') : null;
  const NGINX_BASE_APPDEST = process.env.TRIM_APPDEST ? path.resolve(process.env.TRIM_APPDEST, './server/nginx') : null;
  if (NGINX_BASE_VAR === null || NGINX_BASE_APPDEST === null) return
  // 判断 nginx文件夹 是否存在
  if (!fs.existsSync(NGINX_BASE_VAR)) {
    console.log('没有 nginx 文件夹，复制到 pkgvar 位置')
    // 复制 nginx 到 pkgvar 位置
    fs.cpSync(NGINX_BASE_APPDEST, NGINX_BASE_VAR, { recursive: true });
  }
  // 启动nginx
  nginxUtils.start()
}

try {
  initNginx()
} catch (error) {
  console.error('初始化 nginx 失败', error);
}

// 管理接口需要实时数据，关闭 ETag 以免返回 304 空响应
app.set('etag', false);

// 统一网关会把 /app/simple-nginx 前缀原样转发，这里统一去掉，
// 后续静态资源与路由仍然按 / 和 /api 处理
const GATEWAY_PREFIX = '/app/simple-nginx';
app.use(function (req, res, next) {
  const url = req.url || '';
  if (url === GATEWAY_PREFIX || url.indexOf(GATEWAY_PREFIX + '/') === 0 || url.indexOf(GATEWAY_PREFIX + '?') === 0) {
    let rest = url.slice(GATEWAY_PREFIX.length);
    if (!rest || rest.charAt(0) === '?') rest = '/' + rest;
    req.url = rest;
  }
  next();
});

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRouter);
app.use('/', indexRouter);
app.use('/users', usersRouter);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
