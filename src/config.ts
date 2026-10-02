// 网站归属 / 版权署名。所有对外露出的地方（界面、PDF、地图署名、HTML meta）
// 都从这里取，避免同一个名字在不同文件里各写一份、改名时漏掉。
export const SITE_OWNER = '星球小捕手'

// 高德底图：栅格瓦片直连 is.autonavi.com，无需 key 即可访问。
// 如需使用高德 JS API（地理编码/路径等）能力，在此填入你的 Web 端 key。
export const AMAP_KEY = ''

// 高德地理编码（搜索框主搜，需 AMAP_KEY；留空则搜索回退 Nominatim）
export const AMAP_GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/geo'

// Nominatim（海外地名兜底）。注意：国内对 nominatim.openstreetmap.org 的连通性
// 时好时坏（2026-10-03 实测完全连不上），不能作为唯一搜索源。
export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search'

// Photon（komoot 的 OSM 地理编码，免 key、CORS 全开、返回 WGS84）。
// 国内实测可达（~4s），作为 Nominatim 挂掉时的第一兜底。
export const PHOTON_SEARCH_URL = 'https://photon.komoot.io/api/'
