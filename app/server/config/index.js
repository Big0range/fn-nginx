const path = require('path');
const DATA_BASE = process.env.TRIM_APPDEST ? path.resolve(process.env.TRIM_APPDEST, './server/database') : path.resolve(__dirname, '../database');

const PORT = process.env.wizard_port || process.env.TRIM_SERVICE_PORT || '12400';

const NGINX = process.env.TRIM_APPDEST ? path.resolve(process.env.TRIM_APPDEST, './server/nginx/sbin/nginx') : path.resolve(__dirname, '../nginx/sbin/nginx');

const NGINX_P = path.resolve(NGINX, "../../")

const NGINX_C = path.resolve(NGINX, "../../", "conf/nginx.conf")

const NGINX_D = path.resolve(NGINX, "../../", "conf.d/")

module.exports = {
    DATA_BASE,
    PORT,
    NGINX,
    NGINX_P,
    NGINX_C,
    NGINX_D
}