// 万宝楼估价助手 - Background Service Worker
// 负责：跨域调用爱剑三估价接口、存储管理

const AIJX3_ORIGIN = "https://www.aijx3.cn";
const API_BASE = AIJX3_ORIGIN + "/api2/web";

// 存储 key
const STORAGE_KEYS = {
  roleList: "roleList",    // 万宝楼当前角色列表
  result: "resultList",    // 估价结果历史列表
  compare: "compareList",  // 对比列表
  favorite: "favoriteList" // 收藏列表
};

/**
 * 将商品编号转成 zhanghaoId（爱剑三内部账号 ID）
 * 对应搜索页「搜编号」的逻辑：GET /api2/web/getZhanghaoResultWbl3
 */
async function fetchZhanghaoId(accoSeq) {
  const params = new URLSearchParams({
    fangAnName: "",
    notNeedString: ",",
    needString: ",",
    keyWord: "",
    accoSeq: accoSeq,
    zhenYing: "",
    accountType: "",
    orderMode: "1",
    detailType: "1",
    tradeType: "1",
    tradeStatus: "",
    accountDay: "",
    prefer: "1",
    haveDifPrice: "0",
    searchData: ",",
    notSearchData: ",",
    page: "1",
    size: "20",
    orderBy: "replyTime"
  });

  const url = `${API_BASE}/getZhanghaoResultWbl3?${params.toString()}`;

  // 爱剑三对新账号采用「懒收录」机制：第一次搜索会触发后台抓取万宝楼账号，
  // 可能返回空，需要延迟后重试。
  const MAX_RETRY = 4;
  const RETRY_DELAY = 1200;
  let lastList = [];

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const resp = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json" }
    });

    if (!resp.ok) {
      throw new Error(`搜索接口请求失败：HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const list = data && data.zhanghaoDataList;
    if (Array.isArray(list) && list.length) {
      return list[0].zhanghaoId;
    }
    lastList = list || [];

    if (attempt < MAX_RETRY - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY * (attempt + 1)));
    }
  }

  throw new Error("没有查询到相关的万宝楼内容");
}

/**
 * 根据 zhanghaoId 调用估价接口，返回估价结果
 * 对应结果页逻辑：POST /api2/web/dispath, method=guji.compute.account.by.id
 */
async function fetchAppraise(zhanghaoId, valueType = 2) {
  const body = new URLSearchParams({
    method: "guji.compute.account.by.id",
    zhanghaoId: String(zhanghaoId),
    valueType: String(valueType),
    ver: "1.0"
  });

  const resp = await fetch(`${API_BASE}/dispath`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept": "application/json"
    },
    body: body.toString()
  });

  if (!resp.ok) {
    throw new Error(`估价接口请求失败：HTTP ${resp.status}`);
  }

  const raw = await resp.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error("估价接口返回数据解析失败");
  }

  const result = json && json.result;
  if (!result || result.code !== 0) {
    const code = result && result.code;
    if (code === 13) {
      // 未登录
      const err = new Error("需要登录爱剑三账号才能估价，请先登录");
      err.needLogin = true;
      throw err;
    }
    const msg = (result && result.msg) || "估价失败";
    throw new Error(msg);
  }
  return json.data;
}

/**
 * 完整估价流程：编号 -> zhanghaoId -> 估价结果
 */
async function appraiseBySeq(accoSeq) {
  const zhanghaoId = await fetchZhanghaoId(accoSeq);
  const data = await fetchAppraise(zhanghaoId);
  return {
    accoSeq,
    zhanghaoId,
    data,
    timestamp: Date.now()
  };
}

// 万宝楼列表接口
const WBL_API_BASE = "https://trade-api.seasunwbl.com/api";

/**
 * 获取万宝楼在售角色列表（无需登录），返回精简的商品信息
 * 列表接口即页面「买角色」列表的数据来源，consignment_id 就是商品编号
 * @param {Object} opts
 * @param {Object|null} opts.params 自定义查询参数（由 content 脚本从页面筛选请求中捕获）
 */
async function fetchRoleList({ params: customParams = null } = {}) {
  // 默认参数（与页面无筛选时的请求一致）
  const defaultParams = {
    game_id: "jx3",
    "filter[state]": "0",
    "filter[price]": "0",
    "filter[role_camp]": "0",
    "filter[role_experience_point]": "0",
    "filter[role_equipment_point]": "0",
    "filter[role_equipment_pvp_point]": "0",
    "filter[role_equipment_pve_point]": "0",
    "filter[role_level]": "0",
    "filter[role_hundred_war_endurance]": "0",
    "filter[role_hundred_war_spirit]": "0",
    "filter[role_zixing_point]": "0",
    "filter[role_homeland_level]": "0",
    game: "jx3",
    page: "1",
    size: "10",
    goods_type: "2",
    "sort[single_count_price]": "0",
    zone_id: "",
    server_id: ""
  };

  // 合并：以捕获到的页面参数为准，缺失项用默认值兜底
  const merged = Object.assign({}, defaultParams, customParams || {});

  // 去掉 JSONP 相关参数，直接请求 JSON
  delete merged.req_id;
  delete merged.callback;
  delete merged.__ts__;

  const params = new URLSearchParams();
  Object.keys(merged).forEach((k) => {
    params.append(k, merged[k]);
  });

  const resp = await fetch(`${WBL_API_BASE}/buyer/goods/list?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  });

  if (!resp.ok) {
    throw new Error(`列表接口请求失败：HTTP ${resp.status}`);
  }

  const json = await resp.json();
  if (!json || json.code !== 1) {
    throw new Error((json && json.msg) || "列表获取失败");
  }

  const list = (json.data && json.data.list) || [];
  return list.map((item) => ({
    consignmentId: item.consignment_id,
    roleName: item.seller_role_name,
    serverName: item.server_name,
    zoneName: item.zone_name,
    sect: item.attrs && item.attrs.role_sect,
    shape: item.attrs && item.attrs.role_shape,
    camp: item.attrs && item.attrs.role_camp,
    level: item.attrs && item.attrs.role_level,
    price: item.single_unit_price != null ? item.single_unit_price / 100 : null,
    state: item.state
  }));
}

// 存储辅助
async function getList(key) {
  const obj = await chrome.storage.local.get(key);
  return Array.isArray(obj[key]) ? obj[key] : [];
}

async function setList(key, list) {
  await chrome.storage.local.set({ [key]: list });
}

// 监听万宝楼列表请求（JSONP script），在网络层可靠捕获翻页/筛选参数。
// 页面使用捕获的原生引用创建 JSONP <script>，主世界 hook 无法拦截，
// 因此改用 webRequest 监听 goods/list 请求，把完整筛选参数转发给内容脚本。
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const params = {};
      url.searchParams.forEach((v, k) => { params[k] = v; });
      chrome.tabs.sendMessage(details.tabId, { type: "WBL_LIST_PARAMS", params }, () => {
        // 内容脚本可能尚未注入，忽略发送失败
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  },
  { urls: ["*://trade-api.seasunwbl.com/api/buyer/goods/list*"] }
);

// 消息监听
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "appraise": {
          const result = await appraiseBySeq(msg.accoSeq);
          sendResponse({ ok: true, result });
          break;
        }

        case "getRoleList": {
          const list = await fetchRoleList({ params: msg.params || null });
          sendResponse({ ok: true, list });
          break;
        }

        case "saveResult": {
          // 估价结果存入结果列表（按编号去重覆盖）
          const list = await getList(STORAGE_KEYS.result);
          const idx = list.findIndex(r => r.accoSeq === msg.record.accoSeq);
          if (idx >= 0) {
            list[idx] = msg.record;
          } else {
            list.unshift(msg.record); // 最新的放最前
          }
          await setList(STORAGE_KEYS.result, list);
          sendResponse({ ok: true, count: list.length });
          break;
        }

        case "getResult": {
          const list = await getList(STORAGE_KEYS.result);
          sendResponse({ ok: true, list });
          break;
        }

        case "removeResult": {
          let list = await getList(STORAGE_KEYS.result);
          list = list.filter(r => r.accoSeq !== msg.accoSeq);
          await setList(STORAGE_KEYS.result, list);
          sendResponse({ ok: true, count: list.length });
          break;
        }

        case "clearResult": {
          await setList(STORAGE_KEYS.result, []);
          sendResponse({ ok: true });
          break;
        }

        case "saveRoleList": {
          await chrome.storage.local.set({ [STORAGE_KEYS.roleList]: msg.list || [] });
          sendResponse({ ok: true });
          break;
        }

        case "getStoredRoleList": {
          const obj = await chrome.storage.local.get(STORAGE_KEYS.roleList);
          sendResponse({ ok: true, list: obj[STORAGE_KEYS.roleList] || [] });
          break;
        }

        case "addCompare": {
          const list = await getList(STORAGE_KEYS.compare);
          const idx = list.findIndex(r => r.accoSeq === msg.record.accoSeq);
          if (idx >= 0) {
            list[idx] = msg.record; // 覆盖更新
          } else {
            list.push(msg.record);
          }
          await setList(STORAGE_KEYS.compare, list);
          sendResponse({ ok: true, count: list.length });
          break;
        }

        case "removeCompare": {
          let list = await getList(STORAGE_KEYS.compare);
          list = list.filter(r => r.accoSeq !== msg.accoSeq);
          await setList(STORAGE_KEYS.compare, list);
          sendResponse({ ok: true, count: list.length });
          break;
        }

        case "getCompare": {
          const list = await getList(STORAGE_KEYS.compare);
          sendResponse({ ok: true, list });
          break;
        }

        case "clearCompare": {
          await setList(STORAGE_KEYS.compare, []);
          sendResponse({ ok: true });
          break;
        }

        case "addFavorite": {
          const list = await getList(STORAGE_KEYS.favorite);
          const idx = list.findIndex(r => r.accoSeq === msg.record.accoSeq);
          if (idx >= 0) {
            list[idx] = msg.record;
          } else {
            list.push(msg.record);
          }
          await setList(STORAGE_KEYS.favorite, list);
          sendResponse({ ok: true, count: list.length });
          break;
        }

        case "removeFavorite": {
          let list = await getList(STORAGE_KEYS.favorite);
          list = list.filter(r => r.accoSeq !== msg.accoSeq);
          await setList(STORAGE_KEYS.favorite, list);
          sendResponse({ ok: true, count: list.length });
          break;
        }

        case "getFavorite": {
          const list = await getList(STORAGE_KEYS.favorite);
          sendResponse({ ok: true, list });
          break;
        }

        case "clearFavorite": {
          await setList(STORAGE_KEYS.favorite, []);
          sendResponse({ ok: true });
          break;
        }

        default: {
          sendResponse({ ok: false, error: "未知消息类型" });
        }
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: e.message || String(e),
        needLogin: !!(e && e.needLogin)
      });
    }
  })();
  return true; // 保持消息通道开启，等待异步 sendResponse
});
