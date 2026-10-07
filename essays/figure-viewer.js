(() => {
    const figures = document.querySelectorAll('.essay-figure');
    if (!figures.length || typeof HTMLDialogElement === 'undefined') return;

    const japanese = document.documentElement.lang.startsWith('ja');
    const dialog = document.createElement('dialog');
    dialog.className = 'figure-viewer';
    dialog.setAttribute('aria-labelledby', 'figureViewerTitle');
    dialog.innerHTML = `
        <div class="figure-viewer-header">
            <h2 id="figureViewerTitle"></h2>
            <div class="figure-viewer-actions">
                <button type="button" class="figure-viewer-zoom" aria-pressed="false"></button>
                <button type="button" class="figure-viewer-close" autofocus></button>
            </div>
        </div>
        <div class="figure-viewer-body">
            <div class="figure-viewer-image"><img alt=""></div>
            <p class="figure-viewer-caption"></p>
        </div>`;
    document.body.append(dialog);

    const title = dialog.querySelector('h2');
    const image = dialog.querySelector('img');
    const caption = dialog.querySelector('.figure-viewer-caption');
    const zoom = dialog.querySelector('.figure-viewer-zoom');
    const close = dialog.querySelector('.figure-viewer-close');
    const scrollArea = dialog.querySelector('.figure-viewer-body');
    let opener;
    close.textContent = '×';
    close.setAttribute('aria-label', japanese ? '閉じる' : 'Close');

    function resetZoom() {
        dialog.classList.remove('is-zoomed');
        zoom.setAttribute('aria-pressed', 'false');
        zoom.textContent = japanese ? '拡大' : 'Zoom in';
    }

    figures.forEach((figure, index) => {
        const link = figure.querySelector('a');
        const source = figure.querySelector('img');
        if (!link || !source) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'figure-viewer-trigger';
        button.setAttribute('aria-label', japanese ? `図${index + 1}を拡大表示` : `Enlarge Figure ${index + 1}`);
        button.setAttribute('aria-haspopup', 'dialog');
        link.replaceWith(button);
        button.append(source);
        button.addEventListener('click', () => {
            opener = button;
            title.textContent = japanese ? `図${index + 1}` : `Figure ${index + 1}`;
            image.src = source.currentSrc || source.src;
            image.alt = source.alt;
            caption.textContent = figure.querySelector('figcaption')?.textContent || '';
            resetZoom();
            dialog.showModal();
            document.documentElement.classList.add('figure-viewer-open');
            scrollArea.scrollTo(0, 0);
        });
    });

    zoom.addEventListener('click', () => {
        const enlarged = dialog.classList.toggle('is-zoomed');
        zoom.setAttribute('aria-pressed', String(enlarged));
        zoom.textContent = enlarged ? (japanese ? '全体表示' : 'Fit to screen') : (japanese ? '拡大' : 'Zoom in');
    });
    close.addEventListener('click', () => dialog.close());
    // Native dialog supplies Escape handling, focus trapping, and an inert background.
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
            event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
        document.documentElement.classList.remove('figure-viewer-open');
        opener?.focus({ preventScroll: true });
    });
})();
