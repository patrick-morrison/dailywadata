// View toggle functionality
const toggleBtns = document.querySelectorAll('.view-toggle-btn');
const calendar = document.querySelector('.calendar');
const MOBILE_BREAKPOINT = 768;

function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
}

function updateView() {
    // On mobile, always use list view and hide toggle
    if (isMobile()) {
        calendar.classList.add('list-view');
        return;
    }

    // On desktop, respect user preference
    const savedView = localStorage.getItem('preferredView');
    if (savedView === 'list') {
        calendar.classList.add('list-view');
        toggleBtns.forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-view="list"]').classList.add('active');
    } else {
        calendar.classList.remove('list-view');
        toggleBtns.forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-view="calendar"]').classList.add('active');
    }
}

// Handle toggle button clicks
toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const view = btn.dataset.view;

        // Update active button
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update calendar class
        if (view === 'list') {
            calendar.classList.add('list-view');
        } else {
            calendar.classList.remove('list-view');
        }

        // Save preference
        localStorage.setItem('preferredView', view);
    });
});

// Handle window resize
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(updateView, 150);
});

// Initialize on page load
updateView();
