(function() {
    // ================================
    // 配置参数
    // ================================
    const CONFIG = {
        activeZIndex: 50,        // 激活条目的 z-index
        visibleCount: 11,        // 可见条目数量（奇数）
        spacing: 15,             // 每条条目角度间隔（度数）
        mobileSpacing: 8,        // 移动端 spacing
        mobileThreshold: 820,    // 移动端阈值（px）
        radius: 300,             // 圆弧半径
        scrollUnit: 120,         // 一格滚动单位
        animateSpeed: 5,         // 动画速度（数值越大越快）
        touchMoveFactor: 0.05,   // 触屏/拖拽灵敏度
        opacityFactor: 0.15,     // 不透明度衰减因子
        scaleFactor: 1.5,        // 激活条目的缩放比例
        offsetX: 0,              // X 轴偏移
        snapDelay: 150,          // 自动吸附延迟（ms）
        detailFadeDelay: 500,    // detail 区淡出延迟（ms）
        gapThreshold: 0.01       // 位置差异阈值（小于该值时认为已到达目标位置）
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
    let tracks = [];
    let offset = 0;
    let targetOffset = 0;

    function sliderToOffset(value) {
        return tracks.length - 1 - Number(value);
    }

    function offsetToSlider(value) {
        return tracks.length - 1 - value;
    }

    // ================================
    // DOM 查询 / IO 操作
    // ================================
    function getDetailElements() {
        const detail = document.querySelector('.track-detail');
        return detail ? {
            detail,
            cover: detail.querySelector('.track-cover img'),
            title: detail.querySelector('.track-info-title'),
            description: detail.querySelector('.track-info-description'),
            meta: detail.querySelector('.track-info-meta'),
            link: detail.querySelector('.track-info-readmore')
        } : null;
    }

    // ================================
    // 初始化 track 样式
    // ================================
    function initTrackStyles() {
        tracks.forEach(track => {
            track.style.position = 'absolute';
            track.style.left = '0';
            track.style.top = '0';
            track.style.transformOrigin = 'left center';
            track.dataset.height = track.offsetHeight || track.getBoundingClientRect().height || 0;
        });
    }

    // ================================
    // 初始化 track 条目
    // ================================
    function initTracks() {
        tracks = Array.from(osuWheel.querySelectorAll('.track'))
            .sort((a, b) => new Date(b.dataset.created) - new Date(a.dataset.created));
    }

    // ================================
    // track 点击 / 触摸激活
    // ================================
    function initTrackInteraction() {
        tracks.forEach((track, i) => {
            let touchMoved = false;
            track.addEventListener('click', () => targetOffset = i);
            track.addEventListener('touchstart', () => touchMoved = false, { passive: true });
            track.addEventListener('touchmove', () => touchMoved = true, { passive: true });
            track.addEventListener('touchend', e => {
                if (!touchMoved) {
                    e.preventDefault();
                    targetOffset = i;
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
        tracks.forEach(track => resizeObserver.observe(track));
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
        if (snapTimer) clearTimeout(snapTimer);
        snapTimer = setTimeout(() => {
            targetOffset = Math.round(targetOffset);
        }, CONFIG.snapDelay);
    }

    // ================================
    // 更新右侧 detail 区内容
    // ================================
    function updateDetail(activeTrack) {
        const elems = getDetailElements();
        if (!elems || !activeTrack) return;

        const { detail, cover, title, description, meta, link } = elems;
        const apply = () => {
            detail.classList.remove('fade-out');
            detail.classList.add('fade-in');

            const newTitle = activeTrack.dataset?.title ?? '';
            const newDescription = activeTrack.dataset?.description ?? '';
            const newCover = activeTrack.dataset?.cover ?? '';
            const newLink = activeTrack.dataset?.link ?? '#';
            const newMeta = activeTrack.querySelector('.track-meta-html')?.innerHTML ?? '';

            if (title.textContent !== newTitle) title.textContent = newTitle;
            if (description.innerHTML !== newDescription) description.innerHTML = newDescription;
            if (cover.src !== newCover) {
                cover.src = newCover;
                container.style.setProperty('--bg-url', `url(${newCover || ''})`);
            }
            if (meta.innerHTML !== newMeta) meta.innerHTML = newMeta;
            if (link.href !== newLink) link.href = newLink;
        };

        detail.classList.remove('fade-in');
        detail.classList.add('fade-out');
        if (detailTimer) clearTimeout(detailTimer);
        detailTimer = setTimeout(apply, CONFIG.detailFadeDelay);
    }

    // ================================
    // 渲染函数
    // ================================
    function render(timestamp) {
        const centerY = osuWheel.clientHeight / 2;
        const activeIndex = Math.round(offset);
        const startIndex = Math.max(0, activeIndex - halfVisible);
        const endIndex = Math.min(tracks.length - 1, activeIndex + halfVisible);

        for (let i = 0; i < startIndex; i++) tracks[i].style.display = 'none';
        for (let i = endIndex + 1; i < tracks.length; i++) tracks[i].style.display = 'none';

        for (let i = startIndex; i <= endIndex; i++) {
            const track = tracks[i];
            track.style.display = 'flex';

            const diff = offset - i;
            const angle = diff * getSpacing();
            const rad = angle * Math.PI / 180;
            const trackHeight = Number(track.dataset.height) || track.offsetHeight || track.getBoundingClientRect().height || 0;

            const x = CONFIG.offsetX + Math.cos(rad) * CONFIG.radius - CONFIG.radius;
            const y = centerY - trackHeight / 2 + Math.sin(rad) * CONFIG.radius;

            const scale = i === activeIndex ? 1 : Math.max(0, 1 - Math.abs(diff) * 0.1) / CONFIG.scaleFactor;
            const opacity = i === activeIndex ? 1 : Math.max(0, 1 - Math.abs(diff) * CONFIG.opacityFactor);

            track.style.transform = `translate3d(${x}px, ${y}px, 0px) scale(${scale})`;
            track.style.opacity = opacity;
            track.classList.toggle('active', i === activeIndex);
            track.style.zIndex = CONFIG.activeZIndex - Math.abs(activeIndex - i);
        }

        if (activeIndex !== lastActiveIndex) {
            lastActiveIndex = activeIndex;
            updateDetail(tracks[activeIndex]);
        } else if (Math.abs(offset - targetOffset) < CONFIG.gapThreshold) {
            container.classList.add('show-bg');
        } else {
            container.classList.remove('show-bg');
        }

        if (timelineSlider && !isSliderDragging) {
            timelineSlider.value = String(offsetToSlider(offset));
        }
    }

    // ================================
    // 鼠标滚轮事件（统一 scrollUnit） 
    // ================================
    function handleWheel(e) {
        e.preventDefault();
        const deltaOffset = e.deltaY / CONFIG.scrollUnit;
        targetOffset = Math.max(0, Math.min(tracks.length - 1, targetOffset - deltaOffset));
        startSnapTimer();
    }

    // ================================
    // 触屏拖动事件
    // ================================
    function handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        const trackEl = e.target.closest('.track');
        if (!trackEl) return;

        isTouchDragging = true;
        startY = e.touches[0].clientY;
        startOffset = targetOffset;
        if (snapTimer) clearTimeout(snapTimer);
    }

    function handleTouchMove(e) {
        if (!isTouchDragging || e.touches.length !== 1) return;
        e.preventDefault();
        const deltaY = e.touches[0].clientY - startY;
        targetOffset = startOffset + deltaY * CONFIG.touchMoveFactor;
        targetOffset = Math.max(0, Math.min(tracks.length - 1, targetOffset));
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

            offset += (targetOffset - offset) * delta * CONFIG.animateSpeed;
            render(timestamp);
        }
        animationFrameId = requestAnimationFrame(animate);
    }

    // ================================
    // 主初始化函数
    // ================================
    function initOsuWheel() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (snapTimer) clearTimeout(snapTimer);
        if (detailTimer) clearTimeout(detailTimer);
        if (resizeObserver) resizeObserver.disconnect();

        lastActiveIndex = -1;
        offset = 0;
        targetOffset = 0;
        container = document.querySelector('.osu-container');
        osuWheel = document.querySelector('.osu-wheel');
        timelineSlider = document.getElementById('osu-timeline-slider');
        if (!container || !osuWheel) return;

        initTracks();

        if (timelineSlider) {
            timelineSlider.min = '0';
            timelineSlider.max = String(Math.max(0, tracks.length - 1));
            timelineSlider.step = '0.01';
            timelineSlider.value = String(Math.max(0, tracks.length - 1));

            timelineSlider.addEventListener('input', () => {
                targetOffset = Math.max(0, Math.min(tracks.length - 1, sliderToOffset(timelineSlider.value)));
            });
            timelineSlider.addEventListener('pointerdown', () => {
                isSliderDragging = true;
            });
            timelineSlider.addEventListener('pointerup', () => {
                isSliderDragging = false;
                startSnapTimer();
            });
            timelineSlider.addEventListener('change', () => {
                isSliderDragging = false;
                startSnapTimer();
            });
        }

        initTrackStyles();
        initTrackInteraction();
        observeTrackHeights();

        osuWheel.addEventListener('wheel', handleWheel, { passive: false });
        osuWheel.addEventListener('touchstart', handleTouchStart, { passive: true });
        osuWheel.addEventListener('touchmove', handleTouchMove, { passive: false });
        osuWheel.addEventListener('touchend', handleTouchEnd);

        lastTime = null;
        animate();
        render(performance.now());
    }

    window.initOsuWheel = initOsuWheel;

})();
