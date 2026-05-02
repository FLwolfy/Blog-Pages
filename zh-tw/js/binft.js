function binft(targetElement, content) {
  function randomColor() {
    return colors[Math.floor(Math.random() * colors.length)];
  }
  function randomChar() {
    return String.fromCharCode(94 * Math.random() + 33);
  }
  function noise(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const span = document.createElement("span");
      span.textContent = randomChar();
      span.style.color = randomColor();
      frag.appendChild(span);
    }
    return frag;
  }
  function play() {
    if (state.step > 0) {
      state.step--;
    } else {
      state.step = stepGap;
      if (state.prefixP < prefix.length) {
        if (state.prefixP >= 0) state.text += prefix[state.prefixP];
        state.prefixP++;
      } else if (state.skillP < content.length) {
        state.text += content[state.skillP++];
      } else {
        targetElement.textContent = state.text;
        return; // ✅ 播放完即停
      }
    }
    targetElement.textContent = state.text;
    targetElement.appendChild(noise(
      state.prefixP < prefix.length
        ? Math.min(noiseChars, noiseChars + state.prefixP)
        : Math.min(noiseChars, content.length - state.skillP)
    ));
    setTimeout(play, delay);
  }

  const prefix = "";
  const stepGap = 1;
  const delay = 75;
  const noiseChars = 5;
  const colors = [
    "rgb(255,255,255)",
    "rgba(239, 220, 255, 1)",
    "rgba(245, 200, 255, 1)",
    "rgba(255, 180, 190, 1)",
    "rgba(255, 184, 160, 1)"
  ];

  const state = {
    text: "",
    prefixP: -noiseChars,
    skillP: 0,
    step: stepGap
  };

  play();
}
