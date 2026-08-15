// 万宝楼估价助手 - Content Script
// 注入到 jx3.seasunwbl.com，负责：自动提取商品编号 + 悬浮面板 UI

(function () {
  if (window.__wblGujiaInjected) return;
  window.__wblGujiaInjected = true;

  // ---------- 发送消息到 background ----------
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

  // 接收 popup 发来的估价指令
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "appraiseFromPopup") {
      doAppraise(msg.accoSeq);
      sendResponse({ ok: true });
      return;
    }
    // background 通过 webRequest 捕获到列表请求参数后转发而来
    if (msg && msg.type === "WBL_LIST_PARAMS" && msg.params) {
      cachedListParams = msg.params;
      scheduleAutoRefresh();
      sendResponse({ ok: true });
      return;
    }
  });

  // ---------- 商品编号提取 ----------
  // 从页面文本/DOM 中匹配「商品编号：xxx」或「商品编号:xxx」
  // 编号为 18-20 位数字
  const SEQ_RE = /商品编号[：:]\s*(\d{15,20})/;

  function extractSeqFromText(text) {
    const m = text.match(SEQ_RE);
    return m ? m[1] : null;
  }

  // 从整个文档中提取编号（详情弹窗打开后）
  function extractSeqFromDocument() {
    // 优先在可见的 modal / 详情区域查找
    const candidates = document.querySelectorAll(
      '[class*="role-detail"], [class*="roleDetail"], [class*="role-info"], [class*="roleInfo"], .ant-modal'
    );
    for (const el of candidates) {
      const seq = extractSeqFromText(el.textContent || "");
      if (seq) return seq;
    }
    // 兜底：全文档
    return extractSeqFromText(document.body.innerText || "");
  }

  // 尝试从输入框读取（如果用户手动在商品编号搜索框输入了编号）
  function extractSeqFromInput() {
    const input = document.querySelector('input[placeholder*="商品编号"]');
    if (input) {
      const v = input.value.trim();
      if (/^\d{15,20}$/.test(v)) return v;
    }
    return null;
  }

  function getCurrentSeq() {
    return extractSeqFromInput() || extractSeqFromDocument();
  }

  // ---------- 拦截页面列表请求，捕获筛选参数 ----------
  // 万宝楼通过 JSONP（动态 script 标签）加载列表，参数里包含完整的筛选条件。
  // 关键：content script 运行在隔离世界（isolated world），直接 hook document.createElement
  // 无法影响页面主世界的代码。因此需要把 hook 代码注入到页面主世界（main world），
  // 通过 <script> 注入执行，再用 postMessage 把捕获到的参数传回 content script。
  let cachedListParams = null;
  let autoRefreshTimer = null;

  // 捕获到新列表请求后，自动刷新列表数据（防抖）
  function scheduleAutoRefresh() {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      loadRoleList();
    }, 600);
  }

  // 接收 main world hook 传回的消息
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.type === "WBL_LIST_PARAMS" && data.params) {
      cachedListParams = data.params;
      scheduleAutoRefresh();
    }
  });

  // 注入到 main world 的 hook 脚本
  function installListHook() {
    const code = `
      (function () {
        if (window.__wblListHookInstalled) return;
        window.__wblListHookInstalled = true;
        function report(params) {
          try {
            window.postMessage({ type: "WBL_LIST_PARAMS", params: params }, "*");
          } catch (e) {}
        }
        // hook document.createElement
        var origCreate = document.createElement.bind(document);
        document.createElement = function (tagName) {
          var el = origCreate.apply(document, arguments);
          if (String(tagName).toLowerCase() === "script") {
            var desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
            if (desc && desc.set) {
              Object.defineProperty(el, "src", {
                set: function (v) {
                  if (typeof v === "string" && v.indexOf("/goods/list") >= 0) {
                    try {
                      var url = new URL(v, location.origin);
                      var params = {};
                      url.searchParams.forEach(function (val, key) {
                        params[key] = val;
                      });
                      report(params);
                    } catch (e) {}
                  }
                  desc.set.call(this, v);
                },
                get: function () {
                  return desc.get.call(this);
                }
              });
            }
          }
          return el;
        };
      })();
    `;
    const script = document.createElement("script");
    script.textContent = code;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }
  installListHook();

  // ---------- 悬浮面板 UI ----------
  const panel = document.createElement("div");
  panel.className = "wbl-gujia-panel";
  panel.innerHTML = `
    <div class="wg-header">
      <span class="wg-title">估价助手</span>
      <button class="wg-toggle" title="收起/展开">−</button>
    </div>
    <div class="wg-body">
      <div class="wg-row">
        <label>商品编号</label>
        <div class="wg-input-group">
          <input class="wg-seq-input" placeholder="自动获取或手动输入编号" />
          <button class="wg-btn wg-btn-primary wg-fetch-btn">获取</button>
        </div>
      </div>
      <div class="wg-row">
        <button class="wg-btn wg-btn-primary wg-appraise-btn" style="width:100%">立即估价</button>
      </div>
      <div class="wg-status"></div>
      <div class="wg-result" style="display:none"></div>
      <div class="wg-actions" style="display:none">
        <button class="wg-btn wg-btn-save wg-save-temp-btn">保存结果</button>
        <button class="wg-btn wg-btn-compare wg-add-compare-btn">加入对比</button>
        <button class="wg-btn wg-btn-favorite wg-add-fav-btn">加入收藏</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const seqInput = panel.querySelector(".wg-seq-input");
  const statusEl = panel.querySelector(".wg-status");
  const resultEl = panel.querySelector(".wg-result");
  const actionsEl = panel.querySelector(".wg-actions");
  const toggleBtn = panel.querySelector(".wg-toggle");
  const bodyEl = panel.querySelector(".wg-body");

  let collapsed = false;
  let lastResult = null;

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = "wg-status" + (isError ? " wg-error" : " wg-loading");
  }

  function clearStatus() {
    statusEl.textContent = "";
    statusEl.className = "wg-status";
  }

  // 渲染估价结果
  function renderResult(result) {
    lastResult = result;
    const data = result.data || {};
    const priceNum = data.priceNum != null ? data.priceNum : "-";
    const ziliNum = data.ziliNum != null ? data.ziliNum : "-";
    const zhenYing = data.zhenYing || "-";
    const zhanJie = data.zhanJieLevel != null ? data.zhanJieLevel : "-";
    const menpai = data.menpaiName || "";
    const tixing = data.tixingName || "";

    const detailMap = data.detailMap || {};
    const detailHtml = Object.keys(detailMap)
      .map((k) => {
        let v = detailMap[k];
        if (Array.isArray(v)) v = v.join("，");
        return `<div class="wg-detail-item"><span>${k}</span><em>${v || "--"}</em></div>`;
      })
      .join("");

    // 穿过的海景房列表
    const pjData = data.pjData || {};
    const haiJingList = Array.isArray(pjData.haiJingList) ? pjData.haiJingList : [];
    let haijingHtml = "";
    if (haiJingList.length) {
      const rows = haiJingList
        .map((item) => {
          const alias = item.wgAlias ? `「${item.wgAlias}」` : "";
          const name = item.wgName || "";
          const price = item.nowPrice != null ? item.nowPrice : "-";
          let dateStr = "";
          if (item.publishDate) {
            const d = new Date(item.publishDate);
            dateStr = isNaN(d.getTime())
              ? ""
              : `${d.getFullYear()}年${d.getMonth() + 1}月`;
          }
          return `<div class="wg-haijing-item">
            <span class="wg-haijing-name">${dateStr} ${alias}${name}</span>
            <em class="wg-haijing-price">市价 ${price} 元</em>
          </div>`;
        })
        .join("");
      haijingHtml = `
        <div class="wg-haijing">
          <div class="wg-haijing-title">穿过的海景房（${haiJingList.length}）</div>
          <div class="wg-haijing-list">${rows}</div>
        </div>`;
    }

    resultEl.innerHTML = `
      <div class="wg-result-price">
        <div class="wg-price-label">估价结果</div>
        <div class="wg-price-num">${priceNum}<span>元</span></div>
      </div>
      <div class="wg-result-meta">
        <span>${menpai}${tixing ? "·" + tixing : ""}</span>
        <span>${zhenYing} · ${zhanJie}阶</span>
        <span>资历 ${ziliNum}</span>
      </div>
      ${detailHtml ? `<div class="wg-detail-map">${detailHtml}</div>` : ""}
      ${haijingHtml}
      <div class="wg-result-time">估价时间：${new Date(result.timestamp).toLocaleString()}</div>
    `;
    resultEl.style.display = "block";
    actionsEl.style.display = "flex";
  }

  // 估价主流程
  async function doAppraise(seq) {
    if (!seq) {
      setStatus("未获取到商品编号，请先在详情页打开角色详情，或手动输入", true);
      return;
    }
    if (!/^\d{15,20}$/.test(seq)) {
      setStatus("商品编号格式不正确（应为18-20位数字）", true);
      return;
    }
    seqInput.value = seq;
    setStatus("正在估价，请稍候…");
    resultEl.style.display = "none";
    actionsEl.style.display = "none";

    const resp = await sendMsg({ type: "appraise", accoSeq: seq });
    if (!resp || !resp.ok) {
      const errText = resp ? resp.error : "未知错误";
      if (resp && resp.needLogin) {
        setStatus(errText, true);
        // 提供登录入口
        if (!panel.querySelector(".wg-login-tip")) {
          const tip = document.createElement("div");
          tip.className = "wg-login-tip";
          tip.innerHTML =
            '<a href="https://www.aijx3.cn/home/login.html?type=0" target="_blank" style="color:#1e7a8c;">点击登录爱剑三</a>';
          statusEl.parentNode.insertBefore(tip, statusEl.nextSibling);
        }
        return;
      }
      setStatus("估价失败：" + errText, true);
      return;
    }
    // 登录提示消失
    const tip = panel.querySelector(".wg-login-tip");
    if (tip) tip.remove();
    clearStatus();
    renderResult(resp.result);
    // 自动保存估价结果到「估价结果」列表
    sendMsg({ type: "saveResult", record: resp.result });
  }

  // 当前获取到的角色列表缓存
  let currentRoleList = [];

  async function loadRoleList() {
    // 优先复用页面当前筛选条件（如果页面已发起过列表请求）
    const resp = await sendMsg({
      type: "getRoleList",
      params: cachedListParams || null
    });
    if (!resp || !resp.ok) {
      setStatus("列表获取失败：" + (resp ? resp.error : "未知错误"), true);
      return;
    }
    currentRoleList = resp.list || [];
    // 存到 storage，供弹窗「估价列表」tab 展示
    sendMsg({ type: "saveRoleList", list: currentRoleList });
    // 卡片渲染可能晚于数据返回，重试注入直到成功
    retryInject(0);
  }

  // 重试注入：卡片渲染有延迟，多次尝试直到匹配成功
  let injectRetryTimer = null;
  function retryInject(attempt, lastCount) {
    clearTimeout(injectRetryTimer);
    const injectedCount = injectCardButtons(currentRoleList);
    const maxAttempts = 10;

    // 调试提示：显示注入进度
    if (injectedCount > 0) {
      setStatus("已注入 " + injectedCount + " 个卡片按钮");
    }

    // 已成功注入且数量稳定，提前停止（最多再确认 1 次）
    if (injectedCount > 0 && injectedCount === lastCount && attempt >= 2) {
      return;
    }

    if (attempt < maxAttempts) {
      injectRetryTimer = setTimeout(() => retryInject(attempt + 1, injectedCount), 400);
    } else if (injectedCount === 0) {
      setStatus("未匹配到卡片，可能筛选结果为空或页面未加载完", true);
    }
  }

  // ---------- 在页面原生角色卡片上注入按钮 ----------
  // 匹配键：角色名（脱敏）+ 服务器，卡片第2列显示「角色名 / 区服/服务器」
  function buildRoleKey(item) {
    return (item.roleName || "") + "|" + (item.serverName || "");
  }

  // 从角色卡片行中提取「角色名」和「服务器」文本
  function readCardKey(row) {
    // 第2列 roleItemColumn 显示「角色名\n电信区/服务器」
    const cols = Array.from(row.querySelectorAll('[class*="roleItemColumn"]'));
    let name = "";
    let server = "";
    for (const col of cols) {
      const text = (col.innerText || "").replace(/\s+/g, " ");
      // 形如「既*** 电信区/长安城」或「既***/电信区/长安城」
      const m = text.match(/([\u4e00-\u9fa5A-Za-z0-9\*]{2,})\s*[/\s]\s*([\u4e00-\u9fa5]+\/[\u4e00-\u9fa5]+)/);
      if (m) {
        name = m[1].trim();
        const region = m[2].trim(); // 电信区/长安城
        const parts = region.split("/");
        server = parts[parts.length - 1];
        break;
      }
    }
    return name + "|" + server;
  }

  // 注入按钮到单个卡片行（fixed 悬浮，不影响原布局）
  function injectIntoCard(row, item) {
    if (row.querySelector("[data-wg-anchor]")) return; // 已注入
    // 找到「详情」元素作为定位锚点
    const detailEl = Array.from(row.querySelectorAll("*")).find(
      (e) => e.children.length === 0 && e.textContent.trim() === "详情"
    );
    if (!detailEl) return;
    detailEl.setAttribute("data-wg-anchor", "1");

    // 按钮组挂到 body，用 fixed 定位，悬浮在详情按钮下方
    const btnWrap = document.createElement("div");
    btnWrap.className = "wg-card-btns";
    btnWrap.style.position = "fixed";
    btnWrap.style.zIndex = "2147482900";
    btnWrap.innerHTML = `
      <button class="wg-card-btn wg-card-appraise" title="估价">估价</button>
      <button class="wg-card-btn wg-card-fav" title="收藏">收藏</button>
      <button class="wg-card-btn wg-card-compare" title="加入对比">对比</button>
    `;

    btnWrap.querySelector(".wg-card-appraise").addEventListener("click", (e) => {
      e.stopPropagation();
      doAppraise(item.consignmentId);
    });
    btnWrap.querySelector(".wg-card-fav").addEventListener("click", async (e) => {
      e.stopPropagation();
      await addToFavorite(item);
    });
    btnWrap.querySelector(".wg-card-compare").addEventListener("click", async (e) => {
      e.stopPropagation();
      await addToCompare(item);
    });

    document.body.appendChild(btnWrap);

    // 更新 fixed 位置：详情按钮正下方居中
    function updatePosition() {
      const rect = detailEl.getBoundingClientRect();
      // 若锚点已不在文档中（卡片被重建），移除孤儿按钮组
      if (!document.body.contains(detailEl)) {
        btnWrap.remove();
        window.removeEventListener("scroll", updatePosition, true);
        window.removeEventListener("resize", updatePosition);
        return;
      }
      const w = btnWrap.offsetWidth;
      const left = rect.left + rect.width / 2 - w / 2;
      const top = rect.bottom + 6;
      btnWrap.style.left = left + "px";
      btnWrap.style.top = top + "px";
    }

    // 长亮显示
    updatePosition();

    // 滚动/尺寸变化时重新定位
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
  }

  // 收藏（卡片快捷按钮）：收藏角色基本信息
  async function addToFavorite(item) {
    const record = {
      accoSeq: item.consignmentId,
      roleName: item.roleName,
      serverName: item.serverName,
      zoneName: item.zoneName,
      sect: item.sect,
      shape: item.shape,
      camp: item.camp,
      level: item.level,
      price: item.price,
      state: item.state,
      appraised: false,
      timestamp: Date.now()
    };
    const resp = await sendMsg({ type: "addFavorite", record });
    setStatus(resp && resp.ok ? "已收藏：" + item.roleName : "收藏失败", !(resp && resp.ok));
    setTimeout(clearStatus, 1500);
  }

  // 加入对比（卡片快捷按钮）
  async function addToCompare(item) {
    const record = {
      accoSeq: item.consignmentId,
      roleName: item.roleName,
      serverName: item.serverName,
      zoneName: item.zoneName,
      sect: item.sect,
      shape: item.shape,
      camp: item.camp,
      level: item.level,
      price: item.price,
      state: item.state,
      appraised: false,
      timestamp: Date.now()
    };
    const resp = await sendMsg({ type: "addCompare", record });
    setStatus(resp && resp.ok ? "已加入对比：" + item.roleName : "加入对比失败", !(resp && resp.ok));
    setTimeout(clearStatus, 1500);
  }

  // 主注入逻辑：把列表数据匹配到 DOM 卡片并注入按钮
  function injectCardButtons(list) {
    if (!list || !list.length) return 0;

    // 清理旧的按钮组和锚点标记（筛选后卡片可能重建，避免孤儿节点累积）
    document.querySelectorAll(".wg-card-btns").forEach((el) => el.remove());
    document.querySelectorAll("[data-wg-anchor]").forEach((el) => el.removeAttribute("data-wg-anchor"));

    // 行容器类名为 roleItem--xxx（双横线），区别于 roleItemColumn/roleItemMore 等子组件
    const rows = Array.from(document.querySelectorAll('[class*="roleItem--"]')).filter(
      (r) => r.querySelector('[class*="roleItemColumn"]') && r.innerText.includes("详情")
    );
    // 建立 key -> item 映射
    const map = new Map();
    list.forEach((item) => {
      map.set(buildRoleKey(item), item);
    });
    let count = 0;
    rows.forEach((row) => {
      const key = readCardKey(row);
      const item = map.get(key);
      if (item) {
        injectIntoCard(row, item);
        count++;
      }
    });
    return count;
  }

  // 事件绑定
  seqInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      doAppraise(seqInput.value.trim());
    }
  });

  panel.querySelector(".wg-fetch-btn").addEventListener("click", () => {
    const seq = getCurrentSeq();
    if (seq) {
      seqInput.value = seq;
      setStatus("已获取编号：" + seq);
    } else {
      setStatus("未在页面中找到商品编号，请打开角色详情弹窗后重试", true);
    }
  });

  panel.querySelector(".wg-appraise-btn").addEventListener("click", () => {
    doAppraise(seqInput.value.trim() || getCurrentSeq());
  });

  panel.querySelector(".wg-save-temp-btn").addEventListener("click", async () => {
    if (!lastResult) return;
    const resp = await sendMsg({ type: "saveResult", record: lastResult });
    if (resp && resp.ok) {
      setStatus("已保存到估价结果");
      setTimeout(clearStatus, 1500);
    }
  });

  panel.querySelector(".wg-add-compare-btn").addEventListener("click", async () => {
    if (!lastResult) return;
    const resp = await sendMsg({ type: "addCompare", record: lastResult });
    if (resp && resp.ok) {
      setStatus("已加入对比列表");
      setTimeout(clearStatus, 1500);
    }
  });

  panel.querySelector(".wg-add-fav-btn").addEventListener("click", async () => {
    if (!lastResult) return;
    const resp = await sendMsg({ type: "addFavorite", record: lastResult });
    if (resp && resp.ok) {
      setStatus("已加入收藏列表");
      setTimeout(clearStatus, 1500);
    }
  });

  toggleBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    bodyEl.style.display = collapsed ? "none" : "block";
    toggleBtn.textContent = collapsed ? "+" : "−";
  });

  // ---------- 面板拖拽移动 ----------
  function enableDrag() {
    const header = panel.querySelector(".wg-header");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    header.style.cursor = "move";
    header.addEventListener("mousedown", (e) => {
      // 点击按钮不触发拖拽
      if (e.target.closest(".wg-toggle")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let left = origLeft + dx;
      let top = origTop + dy;
      // 限制在视口内
      const rect = panel.getBoundingClientRect();
      left = Math.max(0, Math.min(left, window.innerWidth - rect.width));
      top = Math.max(0, Math.min(top, window.innerHeight - 40));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }
  enableDrag();

  // 自动检测：详情弹窗打开时自动提取编号填入输入框
  // 注意：卡片注入不放在 MutationObserver 里（会与 injectCardButtons 的清理操作互相触发），
  // 而是依赖 loadRoleList 内部的 retryInject 定时重试。
  const observer = new MutationObserver(() => {
    if (!seqInput.value) {
      const seq = getCurrentSeq();
      if (seq) {
        seqInput.value = seq;
        seqInput.dispatchEvent(new Event("change"));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 初始尝试
  setTimeout(() => {
    const seq = getCurrentSeq();
    if (seq) seqInput.value = seq;
    // 页面加载后自动拉取列表并注入卡片按钮
    loadRoleList();
  }, 1500);
})();
