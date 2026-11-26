const path = require('path');

const PORT = process.env.wizard_port || process.env.TRIM_SERVICE_PORT || '12400';

const NGINX = process.env.TRIM_PKGVAR ? path.resolve(process.env.TRIM_PKGVAR, './nginx/sbin/nginx') : path.resolve(__dirname, '../nginx/sbin/nginx');

const NGINX_P = path.resolve(NGINX, "../../")

const NGINX_C = path.resolve(NGINX, "../../", "conf/nginx.conf")

const NGINX_D = path.resolve(NGINX, "../../", "conf.d/")

module.exports = {
    PORT,
    NGINX,
    NGINX_P,
    NGINX_C,
    NGINX_D
}