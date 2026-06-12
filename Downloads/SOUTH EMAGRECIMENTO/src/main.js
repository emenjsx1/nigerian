// State Management
const state = {
  nome: 'Friend',
  meta: '',
  corpo_tipo: '',
  areasalvo: [],
  peso_atual: 80,
  altura: 165,
  peso_ideal: 60,
  dia_a_dia: '',
  sono: '',
  agua: '',
  beneficios: [],
  corpo_quer: '',
  imc: 0,
  imc_category: 'normal' // normal, overweight, obese
};

// Quiz steps mapping in sequence
const stepsSequence = [
  'step-lead',          // 1
  'step-objetivo',      // 2
  'step-corpo-tipo',    // 3
  'step-areas-alvo',    // 4 (Multi)
  'step-nome',          // 5
  'step-impacto',       // 6
  'step-felicidade',    // 7
  'step-impedimento',   // 8
  'step-como-funciona', // 9
  'step-beneficios',    // 10 (Multi)
  'step-depoimento',    // 11
  'step-peso-atual',    // 12 (Slider)
  'step-altura',        // 13 (Slider)
  'step-peso-ideal',    // 14 (Slider)
  'step-dia-dia',       // 15
  'step-sono',          // 16
  'step-agua',          // 17
  'step-perfil-imc',    // 18
  'step-carregando',    // 19 (Auto-loading)
  'step-corpo-desejo',  // 20
  'step-oferta'         // 21 (Final VSL / Sales landing)
];

let currentStepIndex = 0;

// Initialize app when DOM loads
document.addEventListener('DOMContentLoaded', () => {
  showStep(currentStepIndex);
  initOptionCards();
  initSliders();
  initAudioPlayers();
  initTimer();
  initFaqs();
  initCarousels();

  // Setup single button click handlers
  document.querySelectorAll('[data-action="next"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      goNext();
    });
  });

  // Name submit custom verification
  const nomeInput = document.getElementById('nome-input');
  if (nomeInput) {
    nomeInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      state.nome = val ? val : 'Friend';
    });
  }
});

// Update progress bar
function updateProgressBar(index) {
  const fill = document.getElementById('progress-bar-fill');
  if (!fill) return;
  // Progress goes up to step 18 (IMC profile), then it is 100% or hidden
  if (index >= stepsSequence.indexOf('step-perfil-imc')) {
    fill.style.width = '100%';
  } else {
    const percentage = (index / stepsSequence.indexOf('step-perfil-imc')) * 100;
    fill.style.width = `${percentage}%`;
  }
}

// Show a specific step view
function showStep(index) {
  if (index < 0 || index >= stepsSequence.length) return;
  
  // Hide all step views
  document.querySelectorAll('.step-view').forEach(view => {
    view.classList.remove('active');
  });

  const stepId = stepsSequence[index];
  const stepView = document.getElementById(stepId);
  if (stepView) {
    stepView.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  updateProgressBar(index);

  // Dynamic injections
  document.querySelectorAll('.dynamic-name').forEach(el => {
    el.textContent = state.nome;
  });

  // Specific Step Handlers
  if (stepId === 'step-perfil-imc') {
    calculateIMC();
  } else if (stepId === 'step-carregando') {
    runLoadingAnimation();
  }
}

// Navigate Forward
function goNext() {
  const currentStepId = stepsSequence[currentStepIndex];

  // Validation checks for specific screens
  if (currentStepId === 'step-nome') {
    const nomeVal = document.getElementById('nome-input').value.trim();
    if (!nomeVal) {
      alert('Please enter your name to continue.');
      return;
    }
  }

  currentStepIndex++;
  showStep(currentStepIndex);
}

// Option Card Click Handler
function initOptionCards() {
  document.querySelectorAll('.option-card').forEach(card => {
    card.addEventListener('click', () => {
      const stepContainer = card.closest('.step-view');
      const isMulti = card.classList.contains('option-card-multi');
      const cardId = card.getAttribute('data-id');
      const name = card.getAttribute('data-name');

      if (isMulti) {
        // Toggle selected state
        card.classList.toggle('selected');
        
        // Update state array
        let arr = state[name] || [];
        if (card.classList.contains('selected')) {
          if (!arr.includes(cardId)) arr.push(cardId);
        } else {
          arr = arr.filter(id => id !== cardId);
        }
        state[name] = arr;
      } else {
        // Single select
        stepContainer.querySelectorAll('.option-card').forEach(c => {
          c.classList.remove('selected');
        });
        card.classList.add('selected');
        state[name] = cardId;

        // Auto advance after 250ms for smooth visual feedback
        setTimeout(() => {
          goNext();
        }, 250);
      }
    });
  });
}

// Custom Sliders Handler
function initSliders() {
  // Weight Current Slider
  const pesoAtualSlider = document.getElementById('peso-atual-slider');
  const pesoAtualVal = document.getElementById('peso-atual-val');
  if (pesoAtualSlider && pesoAtualVal) {
    pesoAtualSlider.addEventListener('input', (e) => {
      pesoAtualVal.textContent = e.target.value;
      state.peso_atual = parseFloat(e.target.value);
    });
  }

  // Height Slider
  const alturaSlider = document.getElementById('altura-slider');
  const alturaVal = document.getElementById('altura-val');
  if (alturaSlider && alturaVal) {
    alturaSlider.addEventListener('input', (e) => {
      alturaVal.textContent = e.target.value;
      state.altura = parseFloat(e.target.value);
    });
  }

  // Target Weight Slider
  const pesoIdealSlider = document.getElementById('peso-ideal-slider');
  const pesoIdealVal = document.getElementById('peso-ideal-val');
  if (pesoIdealSlider && pesoIdealVal) {
    pesoIdealSlider.addEventListener('input', (e) => {
      pesoIdealVal.textContent = e.target.value;
      state.peso_ideal = parseFloat(e.target.value);
    });
  }
}

// Calculate IMC/BMI
function calculateIMC() {
  const heightM = state.altura / 100;
  const imc = state.peso_atual / (heightM * heightM);
  state.imc = imc.toFixed(1);

  // Compute category
  let pointerLeft = 50;
  let textCategory = 'Normal';
  
  if (imc < 18.5) {
    state.imc_category = 'normal';
    pointerLeft = 15;
    textCategory = 'Underweight';
  } else if (imc >= 18.5 && imc < 25) {
    state.imc_category = 'normal';
    pointerLeft = 35;
    textCategory = 'Normal weight';
  } else if (imc >= 25 && imc < 30) {
    state.imc_category = 'overweight';
    pointerLeft = 60;
    textCategory = 'Overweight';
  } else {
    state.imc_category = 'obese';
    pointerLeft = 85;
    textCategory = 'Obese';
  }

  // Render values
  const imcValText = document.getElementById('imc-value-display');
  const imcCatText = document.getElementById('imc-category-display');
  const imcPointer = document.getElementById('imc-gauge-pointer');

  if (imcValText) imcValText.textContent = state.imc;
  if (imcCatText) imcCatText.textContent = textCategory;
  if (imcPointer) imcPointer.style.left = `${pointerLeft}%`;

  // Render warning alert blocks based on IMC category
  document.getElementById('alert-normal').style.display = 'none';
  document.getElementById('alert-overweight').style.display = 'none';
  document.getElementById('alert-obese').style.display = 'none';

  if (state.imc_category === 'normal') {
    document.getElementById('alert-normal').style.display = 'flex';
  } else if (state.imc_category === 'overweight') {
    document.getElementById('alert-overweight').style.display = 'flex';
  } else {
    document.getElementById('alert-obese').style.display = 'flex';
  }
}

// Sequenced Loading Animation
function runLoadingAnimation() {
  const items = document.querySelectorAll('.loading-step-item');
  let currentItemIdx = 0;

  function processItem() {
    if (currentItemIdx >= items.length) {
      // Completed, auto advance to step 20
      setTimeout(() => {
        goNext();
      }, 800);
      return;
    }

    const item = items[currentItemIdx];
    item.classList.add('active');

    // Emulate spinner loading progress
    setTimeout(() => {
      item.classList.remove('active');
      item.classList.add('done');
      currentItemIdx++;
      processItem();
    }, 1200);
  }

  // Reset steps classes
  items.forEach(it => {
    it.classList.remove('active', 'done');
  });

  processItem();
}

// Custom Custom Audio Control Interface
function initAudioPlayers() {
  document.querySelectorAll('.audio-player-card').forEach(player => {
    const audioEl = player.querySelector('audio');
    const playPauseBtn = player.querySelector('.play-pause-btn');
    const playIcon = player.querySelector('.play-icon');
    const pauseIcon = player.querySelector('.pause-icon');
    const fill = player.querySelector('.audio-timeline-fill');
    const curTimeText = player.querySelector('.audio-time-current');
    const totalTimeText = player.querySelector('.audio-time-total');
    const timelineBg = player.querySelector('.audio-timeline-bg');

    if (!audioEl || !playPauseBtn) return;

    // Reset icons
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';

    // Format times MM:SS
    function formatTime(secs) {
      if (isNaN(secs)) return '0:00';
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    // Play/Pause Action
    playPauseBtn.addEventListener('click', () => {
      if (audioEl.paused) {
        // Pause all other audios first
        document.querySelectorAll('audio').forEach(a => {
          if (a !== audioEl) {
            a.pause();
            const card = a.closest('.audio-player-card');
            if (card) {
              card.querySelector('.play-icon').style.display = 'block';
              card.querySelector('.pause-icon').style.display = 'none';
            }
          }
        });

        audioEl.play();
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
      } else {
        audioEl.pause();
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
      }
    });

    // Time update listener
    audioEl.addEventListener('timeupdate', () => {
      const pct = (audioEl.currentTime / audioEl.duration) * 100;
      fill.style.width = `${pct}%`;
      curTimeText.textContent = formatTime(audioEl.currentTime);
    });

    // Set duration details once metadata is loaded
    audioEl.addEventListener('loadedmetadata', () => {
      totalTimeText.textContent = formatTime(audioEl.duration);
    });

    // Timeline clicks
    timelineBg.addEventListener('click', (e) => {
      const rect = timelineBg.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = clickX / rect.width;
      audioEl.currentTime = pct * audioEl.duration;
    });

    // Handle end of playback
    audioEl.addEventListener('ended', () => {
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
      fill.style.width = '0%';
      audioEl.currentTime = 0;
    });
  });
}

// 15-Minute Countdown Timer
function initTimer() {
  const timerDisplay = document.getElementById('timer-display');
  if (!timerDisplay) return;

  let totalSeconds = 15 * 60; // 15 minutes

  function updateDisplay() {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    timerDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  updateDisplay();

  const interval = setInterval(() => {
    totalSeconds--;
    if (totalSeconds < 0) {
      totalSeconds = 15 * 60; // Reset / loop
    }
    updateDisplay();
  }, 1000);
}

// FAQ Accordion
function initFaqs() {
  document.querySelectorAll('.faq-item').forEach(item => {
    const header = item.querySelector('.faq-header');
    header.addEventListener('click', () => {
      const isActive = item.classList.contains('active');
      // Collapse others
      document.querySelectorAll('.faq-item').forEach(it => {
        it.classList.remove('active');
      });
      // Toggle current
      if (!isActive) {
        item.classList.add('active');
      }
    });
  });
}

// Slider Testimonials Carousels
function initCarousels() {
  document.querySelectorAll('.carousel-wrapper').forEach(carousel => {
    const slides = carousel.querySelector('.carousel-slides');
    const dotsContainer = carousel.querySelector('.carousel-dots');
    const slideItems = carousel.querySelectorAll('.carousel-slide');

    if (!slides || !dotsContainer || slideItems.length <= 1) return;

    let activeIdx = 0;
    const dotsList = [];

    // Build indicators dots
    slideItems.forEach((_, index) => {
      const dot = document.createElement('button');
      dot.className = `carousel-dot ${index === 0 ? 'active' : ''}`;
      dot.setAttribute('aria-label', `Slide ${index + 1}`);
      dot.addEventListener('click', () => goToSlide(index));
      dotsContainer.appendChild(dot);
      dotsList.push(dot);
    });

    function goToSlide(index) {
      activeIdx = index;
      slides.style.transform = `translateX(-${index * 100}%)`;
      dotsList.forEach((dot, idx) => {
        dot.className = `carousel-dot ${idx === index ? 'active' : ''}`;
      });
    }

    // Auto rotate every 3.5 seconds
    setInterval(() => {
      let next = activeIdx + 1;
      if (next >= slideItems.length) next = 0;
      goToSlide(next);
    }, 3500);
  });
}
