// 万宝楼估价助手 - Popup 逻辑

let currentTab = "roleList";

// tab 配置：{ key, getMsg, removeMsg, clearMsg, 是否估价结果类型 }
const TABS = {
  roleList: {
    title: "估价列表",
    getMsg: "getStoredRoleList",
    removeMsg: null,      // 角色列表不支持单独移除
    clearMsg: null
  },
  result: {
    title: "估价结果",
    getMsg: "getResult",
    removeMsg: "removeResult",
    clearMsg: "clearResult"
  },
  favorite: {
    title: "收藏列表",
    getMsg: "getFavorite",
    removeMsg: "removeFavorite",
    clearMsg: "clearFavorite"
  },
  compare: {
    title: "对比列表",
    getMsg: "getCompare",
    removeMsg: "removeCompare",
    clearMsg: "clearCompare"
  }
};

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 判断记录是否为已估价结果（有 data 字段）
function isAppraised(r) {
  return !!(r && r.data);
}

function formatPrice(r) {
  if (isAppraised(r)) {
    const d = r.data || {};
    return d.priceNum != null ? d.priceNum : "-";
  }
  return r.price != null ? r.price : "-";
}

function formatMeta(r) {
  if (isAppraised(r)) {
    const d = r.data || {};
    const parts = [];
    const menpai = d.menpaiName || "";
    const tixing = d.tixingName || "";
    if (menpai || tixing) parts.push(menpai + (tixing ? "·" + tixing : ""));
    if (d.zhenYing) parts.push(d.zhenYing);
    if (d.ziliNum != null) parts.push("资历 " + d.ziliNum);
    return parts.join(" · ");
  }
  const parts = [];
  if (r.roleName) parts.push(r.roleName);
  if (r.zoneName || r.serverName) parts.push([r.zoneName, r.serverName].filter(Boolean).join("-"));
  if (r.sect || r.shape) parts.push((r.sect || "") + (r.shape || ""));
  return parts.join(" · ");
}

// 触发估价：在万宝楼页面执行（通过消息通知 content，或新开万宝楼页面）
function triggerAppraise(accoSeq) {
  // 打开万宝楼页面，并让 content 脚本对指定编号估价
  chrome.tabs.query({ url: "https://jx3.seasunwbl.com/*" }, (tabs) => {
    if (tabs && tabs.length) {
      // 已有万宝楼页签，通知其估价
      chrome.tabs.sendMessage(tabs[0].id, { type: "appraiseFromPopup", accoSeq }, () => {
        if (chrome.runtime.lastError) {
          chrome.tabs.update(tabs[0].id, { active: true });
        }
      });
    } else {
      chrome.tabs.create({ url: "https://jx3.seasunwbl.com/buyer?t=role" });
    }
  });
}

// 渲染单个卡片
function renderCard(r, tabKey) {
  const div = document.createElement("div");
  div.className = "card";
  const appraised = isAppraised(r);
  const unevalTag = appraised ? "" : '<i class="tag-uneval">未估价</i>';
  const opsHtml = buildOps(r, tabKey, appraised);

  div.innerHTML = `
    <div class="top">
      <span class="seq">${escapeHtml(r.accoSeq)}</span>
      <span class="price">${escapeHtml(formatPrice(r))} 元${unevalTag}</span>
    </div>
    <div class="meta">${escapeHtml(formatMeta(r))}${r.timestamp ? " · " + new Date(r.timestamp).toLocaleString() : ""}</div>
    <div class="ops">${opsHtml}</div>
  `;

  // 复制编号
  const copyBtn = div.querySelector(".copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(r.accoSeq).then(() => {
        copyBtn.textContent = "已复制";
        setTimeout(() => (copyBtn.textContent = "复制"), 1000);
      });
    });
  }

  // 估价按钮
  const appraiseBtn = div.querySelector(".appraise");
  if (appraiseBtn) {
    appraiseBtn.addEventListener("click", () => triggerAppraise(r.accoSeq));
  }

  // 打开结果页
  const openBtn = div.querySelector(".open");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      const url = r.zhanghaoId
        ? "https://www.aijx3.cn/appraise/result.html?zhanghaoId=" + r.zhanghaoId
        : "https://www.aijx3.cn/appraise/search.html";
      chrome.tabs.create({ url });
    });
  }

  // 移除按钮
  const removeBtn = div.querySelector(".remove");
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      const cfg = TABS[tabKey];
      if (cfg.removeMsg) {
        await sendMsg({ type: cfg.removeMsg, accoSeq: r.accoSeq });
        await render();
      }
    });
  }

  return div;
}

function buildOps(r, tabKey, appraised) {
  const cfg = TABS[tabKey];
  let html = "";

  if (tabKey === "roleList") {
    // 估价列表：估价 + 收藏 + 对比
    html += '<button class="primary appraise">估价</button>';
    html += '<button class="fav">收藏</button>';
    html += '<button class="cmp">对比</button>';
  } else if (tabKey === "result") {
    // 估价结果：复制 + 打开 + 收藏 + 对比 + 移除
    html += '<button class="copy">复制</button>';
    html += '<button class="open">打开</button>';
    html += '<button class="fav">收藏</button>';
    html += '<button class="cmp">对比</button>';
    html += '<button class="remove danger">移除</button>';
  } else {
    // 收藏 / 对比列表：估价 + 复制 + 打开 + 移除
    html += '<button class="primary appraise">估价</button>';
    html += '<button class="copy">复制</button>';
    if (appraised) html += '<button class="open">打开</button>';
    html += '<button class="remove danger">移除</button>';
  }

  // 绑定收藏/对比按钮（事件委托在 render 后统一处理）
  return html;
}

// 统一的收藏/对比按钮事件绑定
function bindFavAndCompare(div, r) {
  const favBtn = div.querySelector(".fav");
  const cmpBtn = div.querySelector(".cmp");
  if (favBtn) {
    favBtn.addEventListener("click", async () => {
      const record = isAppraised(r) ? r : { ...r };
      const resp = await sendMsg({ type: "addFavorite", record });
      favBtn.textContent = resp && resp.ok ? "已收藏" : "失败";
      setTimeout(() => (favBtn.textContent = "收藏"), 1000);
    });
  }
  if (cmpBtn) {
    cmpBtn.addEventListener("click", async () => {
      const record = isAppraised(r) ? r : { ...r };
      const resp = await sendMsg({ type: "addCompare", record });
      cmpBtn.textContent = resp && resp.ok ? "已加入" : "失败";
      setTimeout(() => (cmpBtn.textContent = "对比"), 1000);
    });
  }
}

async function render() {
  const content = document.getElementById("content");
  const cfg = TABS[currentTab];
  const resp = await sendMsg({ type: cfg.getMsg });
  const list = (resp && resp.ok && resp.list) || [];

  // 更新各 tab 计数
  const counts = {};
  for (const key of Object.keys(TABS)) {
    const r2 = await sendMsg({ type: TABS[key].getMsg });
    counts[key] = (r2 && r2.ok && r2.list ? r2.list.length : 0);
  }
  Object.keys(counts).forEach((key) => {
    const el = document.getElementById("count-" + key);
    if (el) el.textContent = counts[key];
  });

  // 更新清空按钮可用性
  const clearBtn = document.getElementById("clearBtn");
  clearBtn.style.display = cfg.clearMsg ? "" : "none";

  content.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无" + cfg.title + "记录";
    content.appendChild(empty);
    return;
  }
  list.forEach((r) => {
    const card = renderCard(r, currentTab);
    bindFavAndCompare(card, r);
    content.appendChild(card);
  });
}

// Tab 切换
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentTab = tab.dataset.tab;
    render();
  });
});

document.getElementById("openPage").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://jx3.seasunwbl.com/buyer?t=role" });
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  const cfg = TABS[currentTab];
  if (cfg.clearMsg) {
    await sendMsg({ type: cfg.clearMsg });
    await render();
  }
});

render();
