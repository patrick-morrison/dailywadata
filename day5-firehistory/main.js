// Video synchronization
const videoOverall = document.getElementById('video-overall');
const videoPb = document.getElementById('video-pb');
const videoWf = document.getElementById('video-wf');
const playPauseBtn = document.getElementById('play-pause-btn');
const restartBtn = document.getElementById('restart-btn');
const prevFrameBtn = document.getElementById('prev-frame-btn');
const nextFrameBtn = document.getElementById('next-frame-btn');
const yearInput = document.getElementById('year-input');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const btnLabel = document.getElementById('btn-label');

let isPlaying = false;

// Year and frame configuration
const START_YEAR = 2000;
const END_YEAR = 2025;
const TOTAL_YEARS = END_YEAR - START_YEAR + 1; // 26 years
const VIDEO_DURATION = 26.0; // seconds (26 frames at 1fps)
const FRAME_DURATION = VIDEO_DURATION / TOTAL_YEARS; // 1 second per year

// Get time for a specific year
function getTimeForYear(year) {
    const yearIndex = year - START_YEAR;
    return yearIndex * FRAME_DURATION;
}

// Get current year from video time
function getCurrentYear(currentTime) {
    const yearIndex = Math.floor(currentTime / FRAME_DURATION);
    return Math.min(START_YEAR + yearIndex, END_YEAR);
}

// Seek to specific year
function seekToYear(year) {
    const time = getTimeForYear(year);
    videoOverall.currentTime = time;
    videoPb.currentTime = time;
    videoWf.currentTime = time;
    yearInput.value = year;
}

// Update year display based on video time
function updateYearDisplay() {
    const currentYear = getCurrentYear(videoOverall.currentTime);
    yearInput.value = currentYear;
}

// Sync video playback
function syncVideos(sourceVideo, targetVideos) {
    targetVideos.forEach(targetVideo => {
        if (Math.abs(sourceVideo.currentTime - targetVideo.currentTime) > 0.3) {
            targetVideo.currentTime = sourceVideo.currentTime;
        }
    });
}

// Play all videos
function playVideos() {
    videoOverall.play();
    videoPb.play();
    videoWf.play();
    isPlaying = true;
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'inline-flex';
    btnLabel.textContent = 'Pause';
}

// Pause all videos
function pauseVideos() {
    videoOverall.pause();
    videoPb.pause();
    videoWf.pause();
    isPlaying = false;
    playIcon.style.display = 'inline-flex';
    pauseIcon.style.display = 'none';
    btnLabel.textContent = 'Play';
}

// Restart all videos
function restartVideos() {
    seekToYear(START_YEAR);
    playVideos();
}

// Navigate to previous year
function prevYear() {
    const currentYear = getCurrentYear(videoOverall.currentTime);
    if (currentYear > START_YEAR) {
        seekToYear(currentYear - 1);
    }
}

// Navigate to next year
function nextYear() {
    const currentYear = getCurrentYear(videoOverall.currentTime);
    if (currentYear < END_YEAR) {
        seekToYear(currentYear + 1);
    }
}

// Event listeners for synchronization
videoOverall.addEventListener('timeupdate', () => {
    syncVideos(videoOverall, [videoPb, videoWf]);
    updateYearDisplay();
});
videoPb.addEventListener('timeupdate', () => syncVideos(videoPb, [videoOverall, videoWf]));
videoWf.addEventListener('timeupdate', () => syncVideos(videoWf, [videoOverall, videoPb]));

// Control button events
playPauseBtn.addEventListener('click', () => {
    if (isPlaying) {
        pauseVideos();
    } else {
        playVideos();
    }
});

restartBtn.addEventListener('click', restartVideos);
prevFrameBtn.addEventListener('click', prevYear);
nextFrameBtn.addEventListener('click', nextYear);

// Year input event listener
yearInput.addEventListener('change', () => {
    let year = parseInt(yearInput.value);
    // Clamp to valid range
    if (year < START_YEAR) year = START_YEAR;
    if (year > END_YEAR) year = END_YEAR;
    yearInput.value = year;
    seekToYear(year);
});

yearInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        yearInput.blur(); // Trigger change event
    }
});

// Handle video end - loop seamlessly
videoOverall.addEventListener('ended', () => {
    seekToYear(START_YEAR);
    playVideos();
});

videoPb.addEventListener('ended', () => {
    seekToYear(START_YEAR);
    playVideos();
});

videoWf.addEventListener('ended', () => {
    seekToYear(START_YEAR);
    playVideos();
});

// Initialize
window.addEventListener('load', () => {
    seekToYear(START_YEAR);
    playVideos();
});
