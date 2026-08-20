(() => {
    const essayContent = document.querySelector(".essay-content");

    if (!essayContent || document.getElementById("readingProgress")) {
        return;
    }

    const readingProgress = document.createElement("div");
    const readingProgressBar = document.createElement("div");
    const language = document.documentElement.lang.toLowerCase();
    const progressLabel = language.startsWith("ja")
        ? "読書の進捗"
        : language.startsWith("fr")
            ? "Progression de la lecture"
            : "Reading progress";

    readingProgress.className = "reading-progress";
    readingProgress.id = "readingProgress";
    readingProgress.setAttribute("role", "progressbar");
    readingProgress.setAttribute("aria-label", progressLabel);
    readingProgress.setAttribute("aria-valuemin", "0");
    readingProgress.setAttribute("aria-valuemax", "100");
    readingProgress.setAttribute("aria-valuenow", "0");
    readingProgressBar.className = "reading-progress-bar";
    readingProgress.appendChild(readingProgressBar);
    document.body.prepend(readingProgress);

    let readingProgressFrame = null;

    function updateReadingProgress() {
        const viewportHeight = window.innerHeight;
        const contentTop = essayContent.getBoundingClientRect().top + window.scrollY;
        const contentEnd = contentTop + essayContent.offsetHeight - viewportHeight;
        const scrollableDistance = Math.max(contentEnd - contentTop, 1);
        const rawProgress = (window.scrollY - contentTop) / scrollableDistance;
        const progress = Math.min(Math.max(rawProgress, 0), 1);
        const hasStartedReading = window.scrollY >= contentTop;
        const hasScrollableContent = essayContent.offsetHeight > viewportHeight;

        readingProgress.style.setProperty("--reading-progress", progress.toFixed(4));
        readingProgress.classList.toggle("is-visible", hasStartedReading && hasScrollableContent);
        readingProgress.setAttribute("aria-valuenow", Math.round(progress * 100));
        readingProgressFrame = null;
    }

    function requestReadingProgressUpdate() {
        if (readingProgressFrame === null) {
            readingProgressFrame = window.requestAnimationFrame(updateReadingProgress);
        }
    }

    window.addEventListener("scroll", requestReadingProgressUpdate, { passive: true });
    window.addEventListener("resize", requestReadingProgressUpdate);
    window.addEventListener("load", requestReadingProgressUpdate);
    window.addEventListener("pageshow", requestReadingProgressUpdate);
    requestReadingProgressUpdate();
})();
