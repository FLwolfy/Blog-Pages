(function() {
    // ================================
    // 配置参数
    // ================================
    const CONFIG = {
        activeZIndex: 50,          // 激活条目的 z-index
        visibleCount: 11,          // 右侧可见条目数量（奇数）
        spacing: 15,               // 每条条目角度间隔（度数）
        mobileSpacing: 8,          // 移动端 spacing
        mobileThreshold: 820,      // 移动端阈值（px）
        radius: 300,               // 圆弧半径
        scrollUnit: 120,           // 一格滚动单位
        scrollDirection: 1,        // 滚动方向：1 为默认，-1 为反向
        touchDirection: -1,        // 触控方向：1 为默认，-1 为反向
        animateSpeed: 5,           // 动画速度（数值越大越快）
        touchMoveFactor: 0.05,     // 触屏/拖拽灵敏度
        scaleFactor: 1.5,          // 激活条目的缩放比例
        offsetX: 0,                // X 轴偏移
        snapDelay: 150,            // 自动吸附延迟（ms）
        detailFadeDelay: 500,      // detail 区淡出延迟（ms）
        gapThreshold: 0.01,        // 位置差异阈值（小于该值时认为已到达目标位置）
        asyncRenderInternal: 30,   // 触发下一个 slot 异步渲染的时间间隔（ms）
        contentFadeInMs: 220,      // 异步内容回填后的淡入时长（ms）
        wheelStopSpeed: 0.55,      // 真实停止判定：速度阈值（offset/s）
        wheelStopStableMs: 120     // 真实停止判定：持续低速时长（ms）
    };

    // ================================
    // 内部状态变量
    // ================================
    let halfVisible = Math.floor(CONFIG.visibleCount / 2);
    let startY = 0;
    let startOffset = 0;
    let resizeObserver = null;
    let lastActiveIndex = -1;
    let animationFrameId = null;
    let snapTimer = null;
    let detailTimer = null;
    let lastTime = null;

    let isTouchDragging = false;

    let container = null;
    let osuWheel = null;
    let timelineSlider = null;
    let isSliderDragging = false;
    let sliderPointerId = null;
    let titleResizeHandler = null;
    let isTimelineTouchDragging = false;
    let timelineTouchStartY = 0;

    let sourceTracks = [];
    let trackPool = [];
    let poolAssignments = [];
    let slotUpdateTokens = [];
    let slotPendingSourceIndex = [];
    let slotPendingToken = [];
    let currentPoolHeadSource = 0;
    let truncationRafId = null;
    let slotRenderCursor = 0;
    let slotRenderUnlockAt = 0;
    let slotRenderRafId = null;
    let offset = 0;
    let targetOffset = 0;
    let wheelInputActive = false;
    let wheelDecayElapsedMs = 0;
    let wheelPrevSpeed = Infinity;
    let detailFlowToken = 0;
    let postCssReadyPromise = null;
    let detailReadyForBg = false;
    let detailNeedsRefreshAfterScroll = false;
    let isNavigatingAway = false;
    let detailRenderUnlockAt = 0;
    let pendingDetailIndex = -1;
    let pendingDetailImmediate = false;
    let detailDisplayedIndex = -1;
    let detailElementsCache = null;
    const detailHtmlCache = new WeakMap();

    function getPoolSize() {
        return Math.max(2, CONFIG.visibleCount * 2);
    }

    function getLeadSlotCount() {
        return CONFIG.visibleCount - 1;
    }

    function getTrackCount() {
        return sourceTracks.length;
    }

    function getMaxOffset() {
        return Math.max(0, getTrackCount() - 1);
    }

    function clampOffset(value) {
        return clamp(value, 0, getMaxOffset());
    }

    function isValidSourceIndex(index) {
        return index >= 0 && index < getTrackCount();
    }

    function sliderToOffset(value) {
        return getTrackCount() - 1 - Number(value);
    }

    function offsetToSlider(value) {
        return getTrackCount() - 1 - value;
    }

    function clamp(num, min, max) {
        return Math.max(min, Math.min(max, num));
    }

    function isPortraitMode() {
        return window.matchMedia('(orientation: portrait)').matches;
    }

    function setSliderTargetFromPointer(clientX, clientY) {
        if (!timelineSlider) return;
        const rect = timelineSlider.getBoundingClientRect();
        const isPortrait = isPortraitMode();
        if ((!isPortrait && rect.width <= 0) || (isPortrait && rect.height <= 0)) return;

        const ratio = isPortrait
            ? clamp((rect.bottom - clientY) / rect.height, 0, 1)
            : clamp((clientX - rect.left) / rect.width, 0, 1);
        const sliderValue = ratio * getMaxOffset();
        targetOffset = clampOffset(sliderToOffset(sliderValue));
    }

    function resetDetailQueueState() {
        detailRenderUnlockAt = 0;
        pendingDetailIndex = -1;
        pendingDetailImmediate = false;
        detailDisplayedIndex = -1;
    }

    function ensurePostCssReady() {
        if (postCssReadyPromise) return postCssReadyPromise;

        postCssReadyPromise = new Promise((resolve) => {
            const hrefSuffix = '/css/post.css';
            const existing = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                .find((el) => {
                    const href = el.getAttribute('href') || '';
                    return href.endsWith(hrefSuffix) || href.includes(`${hrefSuffix}?`);
                });

            if (existing) {
                const sheet = existing.sheet;
                if (sheet) {
                    resolve();
                    return;
                }
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => resolve(), { once: true });
                return;
            }

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = hrefSuffix;
            link.dataset.trackPostCss = '1';
            link.addEventListener('load', () => resolve(), { once: true });
            link.addEventListener('error', () => resolve(), { once: true });
            document.head.appendChild(link);
        });

        return postCssReadyPromise;
    }

    function clearSnapTimer() {
        if (!snapTimer) return;
        clearTimeout(snapTimer);
        snapTimer = null;
    }

    function resetWheelStopState() {
        wheelInputActive = false;
        wheelDecayElapsedMs = 0;
        wheelPrevSpeed = Infinity;
    }

    // ================================
    // DOM 查询 / IO 操作
    // ================================
    function getDetailElements() {
        if (detailElementsCache?.detail?.isConnected) return detailElementsCache;

        const detail = document.querySelector('.track-detail');
        detailElementsCache = detail ? {
            detail,
            cover: detail.querySelector('.track-cover img'),
            title: detail.querySelector('.track-info-title'),
            description: detail.querySelector('.track-info-description'),
            meta: detail.querySelector('.track-info-meta'),
            link: detail.querySelector('.track-info-readmore')
        } : null;
        return detailElementsCache;
    }

    function truncateTextToFit(text, maxWidth, font) {
        const canvas = truncateTextToFit.canvas || (truncateTextToFit.canvas = document.createElement('canvas'));
        const ctx = canvas.getContext('2d');
        if (!ctx) return text;
        ctx.font = font;

        if (ctx.measureText(text).width <= maxWidth) return text;

        const suffix = '...';
        const suffixWidth = ctx.measureText(suffix).width;
        const available = Math.max(0, maxWidth - suffixWidth);
        if (available <= 0) return suffix;

        let low = 0;
        let high = text.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const candidate = text.slice(0, mid);
            if (ctx.measureText(candidate).width <= available) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return text.slice(0, low) + suffix;
    }

    function truncateAnchors(anchors) {
        anchors.forEach((anchor) => {
            if (!anchor.dataset.fullTitle) {
                anchor.dataset.fullTitle = (anchor.textContent || '').trim();
            }
            const fullTitle = anchor.dataset.fullTitle || '';
            const titleWrap = anchor.closest('.track-title');
            if (!titleWrap) return;

            const styles = window.getComputedStyle(anchor);
            const rightInset = parseFloat(styles.right) || 0;
            const safeWidth = Math.max(0, titleWrap.clientWidth - rightInset);
            if (safeWidth <= 0) return;

            const font = `${styles.fontStyle} ${styles.fontVariant} ${styles.fontWeight} ${styles.fontSize} / ${styles.lineHeight} ${styles.fontFamily}`;
            anchor.textContent = truncateTextToFit(fullTitle, safeWidth, font);
        });
    }

    function applyTitleTruncation() {
        truncateAnchors(document.querySelectorAll('.osu-container .track-content .track-title a'));
    }

    function forceTitleTruncation() {
        applyTitleTruncation();
    }

    function scheduleTitleTruncation() {
        if (truncationRafId !== null) return;
        truncationRafId = requestAnimationFrame(() => {
            truncationRafId = null;
            applyTitleTruncation();
        });
    }

    function applySlotTitleTruncation(slot) {
        if (!slot) return;
        truncateAnchors(slot.querySelectorAll('.track-content .track-title a'));
    }

    function captureTrackData(track) {
        const metaHtml = track.querySelector('.track-meta-html')?.innerHTML || '';
        return {
            created: track.dataset.created || '',
            title: track.dataset.title || '',
            description: track.dataset.description || '',
            cover: track.dataset.cover || '',
            link: track.dataset.link || '#',
            height: track.offsetHeight || track.getBoundingClientRect().height || 0,
            html: track.innerHTML,
            metaHtml
        };
    }

    function clearDataset(el) {
        Object.keys(el.dataset).forEach((key) => {
            delete el.dataset[key];
        });
    }

    function updateCachedHtml(el, html) {
        if (detailHtmlCache.get(el) === html) return;
        el.innerHTML = html;
        detailHtmlCache.set(el, html);
    }

    function applyTrackDataToSlot(slot, trackData, sourceIndex) {
        clearDataset(slot);
        slot.innerHTML = trackData.html;
        slot.dataset.created = trackData.created;
        slot.dataset.title = trackData.title;
        slot.dataset.description = trackData.description;
        slot.dataset.cover = trackData.cover;
        slot.dataset.link = trackData.link;
        slot.dataset.trackIndex = String(sourceIndex);
        slot.dataset.height = slot.offsetHeight || slot.getBoundingClientRect().height || 0;
        slot.dataset.emptyCard = '0';
    }

    function applyEmptyCardToSlot(slot, trackData, sourceIndex) {
        clearDataset(slot);
        slot.dataset.created = trackData.created;
        slot.dataset.title = trackData.title;
        slot.dataset.description = trackData.description;
        slot.dataset.cover = trackData.cover;
        slot.dataset.link = trackData.link;
        slot.dataset.trackIndex = String(sourceIndex);
        slot.dataset.height = String(trackData.height || 0);
        slot.dataset.emptyCard = '1';
    }

    function applyEmptySlot(slot) {
        clearDataset(slot);
        slot.innerHTML = '';
        slot.dataset.trackIndex = '-1';
        slot.dataset.height = '0';
    }

    function clearSlotPending(slotIndex) {
        slotPendingSourceIndex[slotIndex] = null;
        slotPendingToken[slotIndex] = 0;
    }

    function bindSlotSourceAsync(slotIndex, sourceIndex) {
        const slot = trackPool[slotIndex];
        if (!slot) return;

        const token = (slotUpdateTokens[slotIndex] || 0) + 1;
        slotUpdateTokens[slotIndex] = token;
        slotPendingSourceIndex[slotIndex] = sourceIndex;
        slotPendingToken[slotIndex] = token;
        poolAssignments[slotIndex] = sourceIndex;

        if (isValidSourceIndex(sourceIndex)) {
            slot.classList.add('is-content-hidden');
            applyEmptyCardToSlot(slot, sourceTracks[sourceIndex], sourceIndex);
        } else {
            applyEmptySlot(slot);
            slot.classList.remove('is-content-hidden');
        }
        if (slotRenderRafId === null) {
            slotRenderRafId = requestAnimationFrame(processSlotRenderQueue);
        }
    }

    function bindSlotSourceSync(slotIndex, sourceIndex) {
        const slot = trackPool[slotIndex];
        if (!slot) return;

        clearSlotPending(slotIndex);
        poolAssignments[slotIndex] = sourceIndex;
        slotUpdateTokens[slotIndex] = (slotUpdateTokens[slotIndex] || 0) + 1;

        if (isValidSourceIndex(sourceIndex)) {
            applyTrackDataToSlot(slot, sourceTracks[sourceIndex], sourceIndex);
            slot.classList.remove('is-content-hidden');
        } else {
            applyEmptySlot(slot);
            slot.classList.remove('is-content-hidden');
        }
        // 首屏同步渲染不做淡入，直接完整显示
    }

    const hasPendingSlotRenders = () => slotPendingSourceIndex.some((idx) => idx !== null);

    function processOneSlotRender(slotIndex) {
        const sourceIndex = slotPendingSourceIndex[slotIndex];
        if (sourceIndex === null || sourceIndex === undefined) return;
        const token = slotPendingToken[slotIndex] || 0;
        if (token <= 0) return;

        const slot = trackPool[slotIndex];
        if (!slot) return;

        // 只按“应该渲染的文章 index”判定是否需要渲染。
        const expectedIndex = poolAssignments[slotIndex];
        const renderedIndex = Number(slot.dataset.trackIndex || '-1');
        const isEmptyCard = slot.dataset.emptyCard === '1';

        // 若 pending 已过期（不是当前应该渲染的 index），直接丢弃，等待新任务。
        if (sourceIndex !== expectedIndex) {
            clearSlotPending(slotIndex);
            return;
        }

        // 仅保留该 slot 最新一次 async 请求结果
        if (token !== slotUpdateTokens[slotIndex]) {
            clearSlotPending(slotIndex);
            return;
        }

        // 已经是正确 index 且不是空卡，直接跳过，不重复渲染。
        if (renderedIndex === expectedIndex && !isEmptyCard) {
            clearSlotPending(slotIndex);
            return;
        }

        if (isValidSourceIndex(sourceIndex)) {
            applyTrackDataToSlot(slot, sourceTracks[sourceIndex], sourceIndex);
            slot.style.setProperty('--track-reveal-ms', `${Math.max(1, CONFIG.contentFadeInMs)}ms`);
            slot.classList.add('is-content-hidden');
            // 在 hidden 状态完成排版，然后仅用 opacity 过渡显示
            applySlotTitleTruncation(slot);
            void slot.offsetHeight;

            const revealToken = token;
            requestAnimationFrame(() => {
                if (slotUpdateTokens[slotIndex] !== revealToken) return;
                if (Number(slot.dataset.trackIndex || '-1') !== sourceIndex) return;
                slot.classList.remove('is-content-hidden');
            });
        } else {
            applyEmptySlot(slot);
            slot.classList.remove('is-content-hidden');
        }
        clearSlotPending(slotIndex);
        scheduleTitleTruncation();
    }

    function processSlotRenderQueue(timestamp) {
        slotRenderRafId = null;
        if (!trackPool.length || !getTrackCount()) return;

        // 当前 fade-in 尚未结束，必须等待后续帧再处理下一个 slot。
        if (timestamp < slotRenderUnlockAt) {
            if (hasPendingSlotRenders()) {
                slotRenderRafId = requestAnimationFrame(processSlotRenderQueue);
            }
            return;
        }

        const count = trackPool.length;
        let picked = -1;
        for (let step = 0; step < count; step++) {
            const idx = (slotRenderCursor + step) % count;
            if (slotPendingSourceIndex[idx] !== null && slotPendingSourceIndex[idx] !== undefined) {
                picked = idx;
                break;
            }
        }

        if (picked >= 0) {
            processOneSlotRender(picked);
            slotRenderCursor = (picked + 1) % count;
            slotRenderUnlockAt = timestamp + Math.max(1, CONFIG.asyncRenderInternal);
        }

        if (hasPendingSlotRenders()) {
            slotRenderRafId = requestAnimationFrame(processSlotRenderQueue);
        }
    }

    // ================================
    // 初始化 track 池
    // ================================
    function initTracks() {
        const rawTracks = Array.from(osuWheel.querySelectorAll('.track'))
            .sort((a, b) => new Date(b.dataset.created) - new Date(a.dataset.created));

        sourceTracks = rawTracks.map(captureTrackData);

        const poolSize = getPoolSize();
        trackPool = [];
        poolAssignments = new Array(poolSize).fill(-1);
        slotUpdateTokens = new Array(poolSize).fill(0);
        slotPendingSourceIndex = new Array(poolSize).fill(null);
        slotPendingToken = new Array(poolSize).fill(0);
        slotRenderCursor = 0;
        slotRenderUnlockAt = 0;
        currentPoolHeadSource = -getLeadSlotCount();
        if (slotRenderRafId !== null) {
            cancelAnimationFrame(slotRenderRafId);
            slotRenderRafId = null;
        }

        osuWheel.innerHTML = '';

        for (let i = 0; i < poolSize; i++) {
            const slot = document.createElement('div');
            slot.className = 'track';
            slot.style.position = 'absolute';
            slot.style.left = '0';
            slot.style.top = '0';
            slot.style.transformOrigin = 'left center';
            slot.style.willChange = 'transform, opacity';
            trackPool.push(slot);
            osuWheel.appendChild(slot);
        }
    }

    // ================================
    // track 点击 / 触摸激活
    // ================================
    function initTrackInteraction() {
        trackPool.forEach((track) => {
            let touchMoved = false;
            const activate = () => {
                const idx = Number(track.dataset.trackIndex || '-1');
                if (isValidSourceIndex(idx)) {
                    // 点击切换 track 时，和滚轮一致：先隐藏 detail，等 settle 后再显示
                    if (Math.round(targetOffset) !== idx || Math.abs(offset - idx) > CONFIG.gapThreshold) {
                        hideDetailDuringScroll();
                    }
                    targetOffset = idx;
                }
            };

            track.addEventListener('click', activate);
            track.addEventListener('touchstart', () => {
                touchMoved = false;
            }, { passive: true });
            track.addEventListener('touchmove', () => {
                touchMoved = true;
            }, { passive: true });
            track.addEventListener('touchend', (e) => {
                if (!touchMoved) {
                    e.preventDefault();
                    activate();
                }
            });
        });
    }

    // ================================
    // 监听 track 高度变化
    // ================================
    function observeTrackHeights() {
        resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                entry.target.dataset.height = entry.target.offsetHeight;
            }
        });
        trackPool.forEach(track => resizeObserver.observe(track));
    }

    // ================================
    // 获取当前 spacing（响应式）
    // ================================
    function getSpacing() {
        return window.innerWidth <= CONFIG.mobileThreshold
            ? CONFIG.mobileSpacing
            : CONFIG.spacing;
    }

    // ================================
    // 自动吸附函数
    // ================================
    function startSnapTimer() {
        clearSnapTimer();
        snapTimer = setTimeout(() => {
            targetOffset = Math.round(targetOffset);
            snapTimer = null;
        }, CONFIG.snapDelay);
    }

    function markWheelInputActive() {
        wheelInputActive = true;
        wheelDecayElapsedMs = 0;
        wheelPrevSpeed = Infinity;
        clearSnapTimer();
    }

    function maybeSnapOnPhysicalStop(deltaSec) {
        if (!wheelInputActive || deltaSec <= 0) return;
        const speed = Math.abs(targetOffset - offset) / deltaSec;
        const isDecaying = speed <= wheelPrevSpeed + 0.0001;
        wheelPrevSpeed = speed;

        if (isDecaying && speed <= CONFIG.wheelStopSpeed) {
            wheelDecayElapsedMs += deltaSec * 1000;
        } else {
            wheelDecayElapsedMs = 0;
        }

        if (wheelDecayElapsedMs >= CONFIG.wheelStopStableMs) {
            resetWheelStopState();
            targetOffset = Math.round(targetOffset);
        }
    }

    function setDetailHiddenState({ refreshNeeded = false, navigating = false } = {}) {
        const elems = getDetailElements();
        if (!elems) return;

        if (navigating) isNavigatingAway = true;
        detailFlowToken += 1;
        if (detailTimer) {
            clearTimeout(detailTimer);
            detailTimer = null;
        }
        elems.detail.classList.remove('fade-in');
        elems.detail.classList.add('fade-out');
        elems.detail.classList.add('pending-lock');
        detailReadyForBg = false;
        if (refreshNeeded) detailNeedsRefreshAfterScroll = true;
        container?.classList.remove('show-bg');
    }

    function hideDetailDuringScroll() {
        setDetailHiddenState({ refreshNeeded: true });
    }

    function hideDetailImmediatelyForNavigate() {
        setDetailHiddenState({ navigating: true });
    }

    function getCurrentDetailIndex() {
        if (lastActiveIndex >= 0) return lastActiveIndex;
        return clampOffset(Math.round(offset));
    }

    function hideDetailIfSwitching(nextOffset) {
        const nextIndex = clampOffset(Math.round(nextOffset));
        const currentIndex = getCurrentDetailIndex();
        if (nextIndex === currentIndex) return;
        hideDetailDuringScroll();
    }

    function queueDetailRender(index, immediate = false) {
        if (!isValidSourceIndex(index)) return;
        pendingDetailIndex = index;
        if (immediate) pendingDetailImmediate = true;
    }

    function flushQueuedDetailRender(nowMs) {
        if (pendingDetailIndex < 0 || isNavigatingAway) return;

        const immediate = pendingDetailImmediate;
        if (!immediate && nowMs < detailRenderUnlockAt) return;

        const index = pendingDetailIndex;
        pendingDetailIndex = -1;
        pendingDetailImmediate = false;
        detailRenderUnlockAt = nowMs + Math.max(1, CONFIG.asyncRenderInternal);

        const isFirstDetailPaint = lastActiveIndex === -1;
        const isSwitch = index !== detailDisplayedIndex;
        const needsRefresh = detailNeedsRefreshAfterScroll;
        lastActiveIndex = index;
        detailNeedsRefreshAfterScroll = false;
        // refresh 场景也走过渡，避免偶发“直接闪现”
        updateDetail(sourceTracks[index], immediate || isFirstDetailPaint, isSwitch || needsRefresh);
        detailDisplayedIndex = index;
    }

    function onPageShow() {
        // 浏览器返回（bfcache）后，清掉“正在离开页面”残留状态
        isNavigatingAway = false;
        detailReadyForBg = false;
        detailNeedsRefreshAfterScroll = true;
        resetDetailQueueState();
        container?.classList.remove('show-bg');
    }

    function resetWheelRuntimeState() {
        clearSnapTimer();
        resetWheelStopState();
        if (detailTimer) clearTimeout(detailTimer);
        if (resizeObserver) resizeObserver.disconnect();
        if (truncationRafId !== null) {
            cancelAnimationFrame(truncationRafId);
            truncationRafId = null;
        }
        if (titleResizeHandler) {
            window.removeEventListener('resize', titleResizeHandler);
            titleResizeHandler = null;
        }

        lastActiveIndex = -1;
        detailReadyForBg = false;
        detailNeedsRefreshAfterScroll = false;
        isNavigatingAway = false;
        resetDetailQueueState();
    }

    function shouldHandleNavHideTarget(target) {
        if (!(target instanceof Element)) return false;
        const anchor = target.closest('a');
        if (!anchor) return false;
        const href = anchor.getAttribute('href') || '';
        if (!href || href === '#') return false;
        return Boolean(anchor.closest('.track-title'));
    }

    function bindNavHideEvents() {
        if (!container || container.dataset.navHideBound) return;

        container.addEventListener('pointerdown', (e) => {
            if (!shouldHandleNavHideTarget(e.target)) return;
            hideDetailImmediatelyForNavigate();
        }, true);

        container.addEventListener('click', (e) => {
            if (!shouldHandleNavHideTarget(e.target)) return;
            hideDetailImmediatelyForNavigate();
        }, true);

        container.dataset.navHideBound = '1';
    }

    function bindTimelineEvents(timeline) {
        if (!timeline || timeline.dataset.trackTimelineBound) return;

        // 吞掉事件，避免 timeline 面板滚动/拖动触发页面或外层 wheel 行为
        const absorbEvents = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click'];
        absorbEvents.forEach((eventName) => {
            timeline.addEventListener(eventName, (e) => e.stopPropagation(), { passive: true });
        });

        timeline.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!getTrackCount()) return;
            const deltaOffset = (e.deltaY / CONFIG.scrollUnit) * CONFIG.scrollDirection;
            const nextOffset = clampOffset(targetOffset + deltaOffset);
            hideDetailIfSwitching(nextOffset);
            targetOffset = nextOffset;
            markWheelInputActive();
        }, { passive: false });

        timeline.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            if (!isPortraitMode() || e.touches.length !== 1 || !getTrackCount()) return;
            isTimelineTouchDragging = true;
            timelineTouchStartY = e.touches[0].clientY;
            startOffset = targetOffset;
            clearSnapTimer();
            resetWheelStopState();
        }, { passive: true });

        timeline.addEventListener('touchmove', (e) => {
            e.stopPropagation();
            if (!isTimelineTouchDragging || !isPortraitMode() || e.touches.length !== 1 || !getTrackCount()) return;
            e.preventDefault();
            const deltaY = e.touches[0].clientY - timelineTouchStartY;
            const touchDirection = CONFIG.touchDirection;
            const nextOffset = clampOffset(startOffset + deltaY * CONFIG.touchMoveFactor * touchDirection);
            hideDetailIfSwitching(nextOffset);
            targetOffset = nextOffset;
        }, { passive: false });

        timeline.addEventListener('touchend', (e) => {
            e.stopPropagation();
            if (!isTimelineTouchDragging) return;
            isTimelineTouchDragging = false;
            startSnapTimer();
        }, { passive: true });

        timeline.addEventListener('touchcancel', (e) => {
            e.stopPropagation();
            if (!isTimelineTouchDragging) return;
            isTimelineTouchDragging = false;
            startSnapTimer();
        }, { passive: true });

        timeline.dataset.trackTimelineBound = '1';
    }

    // ================================
    // 更新右侧 detail 区内容
    // ================================
    function updateDetail(activeTrackData, immediate = false, withTransition = true) {
        const elems = getDetailElements();
        if (!elems || !activeTrackData) return;

        detailFlowToken += 1;
        const flowToken = detailFlowToken;
        if (detailTimer) {
            clearTimeout(detailTimer);
            detailTimer = null;
        }

        const { detail, cover, title, description, meta, link } = elems;

        // 统一动画起点：只要要求过渡，就先回到隐藏态，避免浏览器复用旧样式导致“直接闪现”
        if (withTransition) {
            detail.classList.remove('fade-in');
            detail.classList.add('fade-out');
            detail.classList.add('pending-lock');
            container?.classList.remove('show-bg');
        }

        const renderTextWithAutoZh = async (token) => {
            await ensurePostCssReady();
            if (token !== detailFlowToken) return;
            if (window.AutoZh?.ready) await window.AutoZh.ready;
            if (token !== detailFlowToken) return;
            if (window.AutoZh?.refresh) {
                await window.AutoZh.refresh(title);
                if (token !== detailFlowToken) return;
                await window.AutoZh.refresh(description);
            }
            if (token !== detailFlowToken) return;
            requestAnimationFrame(() => {
                if (token !== detailFlowToken) return;
                title.classList.remove('track-text-pending');
                description.classList.remove('track-text-pending');
            });
        };

        const apply = (token) => {
            if (token !== detailFlowToken) return;
            const newTitle = activeTrackData.title || '';
            const newDescription = activeTrackData.description || '';
            const newCover = activeTrackData.cover || '';
            const newLink = activeTrackData.link || '#';

            title.classList.add('track-text-pending');
            description.classList.add('track-text-pending');

            if (title.textContent !== newTitle) title.textContent = newTitle;
            if (cover.src !== newCover) {
                cover.src = newCover;
                container.style.setProperty('--bg-url', `url(${newCover || ''})`);
            }

            const newMeta = activeTrackData.metaHtml || '';
            updateCachedHtml(meta, newMeta);
            if (link.getAttribute('href') !== newLink) link.setAttribute('href', newLink);
            updateCachedHtml(description, newDescription);

            // 关键：等待文字/翻译就绪后再进场，避免 fade 结束后再闪一次
            const textReady = renderTextWithAutoZh(token).catch(() => {
                if (token !== detailFlowToken) return;
                title.classList.remove('track-text-pending');
                description.classList.remove('track-text-pending');
            });

            textReady.then(() => {
                if (token !== detailFlowToken) return;
                detailReadyForBg = true;
                requestAnimationFrame(() => {
                    if (token !== detailFlowToken) return;
                    if (!detailReadyForBg) return;
                    if (withTransition) {
                        // 切换条目：先 detail 进场，再背景淡入
                        requestAnimationFrame(() => {
                            if (token !== detailFlowToken) return;
                            if (!detailReadyForBg) return;
                            detail.classList.remove('pending-lock');
                            detail.classList.remove('fade-out');
                            detail.classList.add('fade-in');
                            requestAnimationFrame(() => {
                                if (token !== detailFlowToken) return;
                                if (!detailReadyForBg) return;
                                container?.classList.add('show-bg');
                            });
                        });
                    } else {
                        // 同条目刷新：保持显示，避免二次闪动
                        detail.classList.remove('pending-lock');
                        detail.classList.remove('fade-out');
                        detail.classList.add('fade-in');
                        container?.classList.add('show-bg');
                    }
                });
            });
        };

        if (immediate) {
            apply(flowToken);
            return;
        }

        detailTimer = setTimeout(() => {
            apply(flowToken);
            if (flowToken === detailFlowToken) detailTimer = null;
        }, CONFIG.detailFadeDelay);
    }

    function syncPoolAssignments() {
        if (!trackPool.length) return;

        const base = Math.floor(offset);
        const desiredHead = base - getLeadSlotCount();

        if (poolAssignments.every((v) => v === -1)) {
            currentPoolHeadSource = desiredHead;
            for (let i = 0; i < trackPool.length; i++) {
                bindSlotSourceSync(i, currentPoolHeadSource + i);
            }
            return;
        }

        while (currentPoolHeadSource < desiredHead) {
            // 向前滚动时，复用左侧最底部离场槽位（index 0）到末尾
            const firstTrack = trackPool.shift();
            const firstAssign = poolAssignments.shift();
            const firstToken = slotUpdateTokens.shift();
            if (!firstTrack || firstAssign === undefined || firstToken === undefined) break;

            trackPool.push(firstTrack);
            poolAssignments.push(firstAssign);
            slotUpdateTokens.push(firstToken);

            currentPoolHeadSource += 1;
            const tailIndex = trackPool.length - 1;
            bindSlotSourceAsync(tailIndex, currentPoolHeadSource + tailIndex);
        }

        while (currentPoolHeadSource > desiredHead) {
            const lastTrack = trackPool.pop();
            const lastAssign = poolAssignments.pop();
            const lastToken = slotUpdateTokens.pop();
            if (!lastTrack || lastAssign === undefined || lastToken === undefined) break;

            trackPool.unshift(lastTrack);
            poolAssignments.unshift(lastAssign);
            slotUpdateTokens.unshift(lastToken);

            currentPoolHeadSource -= 1;
            bindSlotSourceAsync(0, currentPoolHeadSource);
        }
    }

    // ================================
    // 渲染函数
    // ================================
    function render() {
        if (!getTrackCount() || !trackPool.length) return;

        const centerY = osuWheel.clientHeight / 2;
        const activeIndex = clampOffset(Math.round(offset));
        const base = Math.floor(offset);
        const frac = offset - base;

        syncPoolAssignments();

        for (let i = 0; i < trackPool.length; i++) {
            const track = trackPool[i];
            const sourceIndex = poolAssignments[i];
            const sourceDiff = sourceIndex - offset;

            const logicalSlot = (i - frac) - getLeadSlotCount();
            const angle = logicalSlot * getSpacing();
            const rad = angle * Math.PI / 180;
            const trackHeight = Number(track.dataset.height) || track.offsetHeight || track.getBoundingClientRect().height || 0;

            const x = CONFIG.offsetX + Math.cos(rad) * CONFIG.radius - CONFIG.radius;
            const y = centerY - trackHeight / 2 + Math.sin(rad) * CONFIG.radius;

            const isValidSource = isValidSourceIndex(sourceIndex);
            const isActive = isValidSource && sourceIndex === activeIndex;
            const scale = isActive ? 1 : Math.max(0, 1 - Math.abs(sourceDiff) * 0.1) / CONFIG.scaleFactor;
            const shouldRender = isValidSource;

            if (shouldRender) {
                const renderedIndex = Number(track.dataset.trackIndex || '-1');
                const isEmptyCard = track.dataset.emptyCard === '1';
                const hasPendingSameSource = slotPendingSourceIndex[i] === sourceIndex;
                if ((renderedIndex !== sourceIndex || isEmptyCard) && !hasPendingSameSource) {
                    bindSlotSourceAsync(i, sourceIndex);
                }
            }

            track.style.transform = `translate3d(${x}px, ${y}px, 0px) scale(${scale})`;
            track.style.visibility = shouldRender ? 'visible' : 'hidden';
            track.style.pointerEvents = shouldRender ? 'auto' : 'none';
            track.classList.toggle('active', isActive);
            track.style.zIndex = String(CONFIG.activeZIndex - Math.round(Math.abs(sourceDiff)));
            // 亮度曲线：中心 1.0，两侧从 0.75 递减到最外侧 0.15（由 :after 控制）
            const distance = Math.abs(logicalSlot);
            const t = clamp((distance - 1) / Math.max(1, halfVisible), 0, 1);
            const brightness = isActive ? 1 : (0.75 - (0.75 - 0.15) * t);
            track.style.setProperty('--track-brightness', String(brightness));

            // 兜底：只要可见且真实内容已写入，不允许残留 hidden
            if (shouldRender && track.dataset.emptyCard !== '1' && slotPendingSourceIndex[i] === null) {
                track.classList.remove('is-content-hidden');
            }
        }

        const nowMs = performance.now();
        if (isNavigatingAway) {
            detailReadyForBg = false;
            container.classList.remove('show-bg');
            resetDetailQueueState();
        } else {
            const snappedIndex = clampOffset(Math.round(targetOffset));
            const shouldQueueUpdate = snappedIndex !== lastActiveIndex || detailNeedsRefreshAfterScroll;
            if (shouldQueueUpdate) {
                // 实时写入缓冲：不论快慢滚动，始终保持最新目标 index
                const immediate = lastActiveIndex === -1;
                queueDetailRender(snappedIndex, immediate);
            }
            // 异步渲染 + 节流：使用 asyncRenderInternal 作为最小渲染间隔
            flushQueuedDetailRender(nowMs);

            // 背景显隐由 updateDetail / hideDetailDuringScroll 统一管理，
            // 避免 render 循环抢写 class 导致“无过渡直接出现”。
        }

        if (timelineSlider) {
            timelineSlider.value = String(offsetToSlider(offset));
        }
    }

    // ================================
    // 鼠标滚轮事件（统一 scrollUnit）
    // ================================
    function handleWheel(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.target.closest('.track-detail')) return;

        const deltaOffset = (e.deltaY / CONFIG.scrollUnit) * CONFIG.scrollDirection;
        const nextOffset = clampOffset(targetOffset + deltaOffset);
        hideDetailIfSwitching(nextOffset);
        targetOffset = nextOffset;
        markWheelInputActive();
    }

    // ================================
    // 触屏拖动事件
    // ================================
    function handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        e.stopPropagation();
        if (e.target.closest('.track-detail')) return;

        isTouchDragging = true;
        startY = e.touches[0].clientY;
        startOffset = targetOffset;
        clearSnapTimer();
        resetWheelStopState();
    }

    function handleTouchMove(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (!isTouchDragging) return;

        const deltaY = e.touches[0].clientY - startY;
        const touchDirection = CONFIG.touchDirection;
        const nextOffset = clampOffset(startOffset + deltaY * CONFIG.touchMoveFactor * touchDirection);
        hideDetailIfSwitching(nextOffset);
        targetOffset = nextOffset;
    }

    function handleTouchEnd() {
        if (!isTouchDragging) return;
        isTouchDragging = false;
        startSnapTimer();
    }

    // ================================
    // 动画循环
    // ================================
    function animate(timestamp) {
        if (timestamp) {
            if (lastTime === null) lastTime = timestamp;
            const delta = (timestamp - lastTime) / 1000;
            lastTime = timestamp;

            if (delta > 0) {
                offset += (targetOffset - offset) * delta * CONFIG.animateSpeed;
                maybeSnapOnPhysicalStop(delta);
            }

            render();
        }
        animationFrameId = requestAnimationFrame(animate);
    }

    // ================================
    // 主初始化函数
    // ================================
    function initOsuWheel() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (slotRenderRafId !== null) {
            cancelAnimationFrame(slotRenderRafId);
            slotRenderRafId = null;
        }
        slotRenderUnlockAt = 0;
        slotRenderCursor = 0;
        resetWheelRuntimeState();
        detailElementsCache = null;
        container = document.querySelector('.osu-container');
        osuWheel = document.querySelector('.osu-wheel');
        const timeline = document.querySelector('.osu-timeline');
        timelineSlider = document.getElementById('osu-timeline-slider');
        if (!container || !osuWheel) return;

        bindNavHideEvents();
        bindTimelineEvents(timeline);

        initTracks();
        if (!getTrackCount()) return;
        offset = getMaxOffset();
        targetOffset = offset;

        if (timelineSlider) {
            timelineSlider.min = '0';
            timelineSlider.max = String(getMaxOffset());
            timelineSlider.step = '0.01';
            timelineSlider.value = String(getMaxOffset());

            if (!timelineSlider.dataset.trackSliderBound) {
                timelineSlider.addEventListener('input', () => {
                    if (!isSliderDragging) {
                        const nextOffset = clampOffset(sliderToOffset(timelineSlider.value));
                        hideDetailIfSwitching(nextOffset);
                        targetOffset = nextOffset;
                    }
                });

                timelineSlider.addEventListener('pointerdown', (e) => {
                    e.preventDefault();
                    isSliderDragging = true;
                    sliderPointerId = e.pointerId;
                    timelineSlider.setPointerCapture?.(e.pointerId);
                    setSliderTargetFromPointer(e.clientX, e.clientY);
                });

                timelineSlider.addEventListener('pointermove', (e) => {
                    if (!isSliderDragging || (sliderPointerId !== null && e.pointerId !== sliderPointerId)) return;
                    e.preventDefault();
                    const prevOffset = targetOffset;
                    setSliderTargetFromPointer(e.clientX, e.clientY);
                    if (targetOffset !== prevOffset) {
                        hideDetailIfSwitching(targetOffset);
                    }
                });

                timelineSlider.addEventListener('pointerup', (e) => {
                    if (sliderPointerId !== null && e.pointerId !== sliderPointerId) return;
                    isSliderDragging = false;
                    sliderPointerId = null;
                    startSnapTimer();
                });

                timelineSlider.addEventListener('pointercancel', (e) => {
                    if (sliderPointerId !== null && e.pointerId !== sliderPointerId) return;
                    isSliderDragging = false;
                    sliderPointerId = null;
                    startSnapTimer();
                });
                timelineSlider.dataset.trackSliderBound = '1';
            }
        }

        initTrackInteraction();
        observeTrackHeights();
        syncPoolAssignments();
        forceTitleTruncation();
        titleResizeHandler = applyTitleTruncation;
        window.addEventListener('resize', titleResizeHandler);

        if (!container.dataset.trackWheelBound) {
            container.addEventListener('wheel', handleWheel, { passive: false });
            container.addEventListener('touchstart', handleTouchStart, { passive: true });
            container.addEventListener('touchmove', handleTouchMove, { passive: false });
            container.addEventListener('touchend', handleTouchEnd);
            container.dataset.trackWheelBound = '1';
        }

        lastTime = null;
        animate();
        render();
    }

    window.initOsuWheel = initOsuWheel;
    window.forceOsuTitleTruncation = forceTitleTruncation;
    window.addEventListener('pageshow', onPageShow);

})();
