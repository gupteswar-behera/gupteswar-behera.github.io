---
layout: single
title: "Projects"
permalink: /projects/
author_profile: true
---

<div class="card" markdown="1">

Hourly CO₂ intensity forecast for the Indian grid
------

A forecast of the hourly CO₂ intensity of the Indian grid for the next 48 hours, published every day and compared with the measured values, so that flexible use such as charging a battery can move to the cleanest hours.

<iframe id="co2-preview" class="co2-preview" src="{{ '/co2-forecast/?preview' | relative_url }}" title="CO2 intensity forecast for the next 48 hours" scrolling="no"></iframe>

[Open the forecast]({{ '/projects/co2-forecast/' | relative_url }})

</div>

<style>
  .co2-preview { display: block; width: 100%; height: 460px; border: 0; overflow: hidden; margin: 0.4em 0 0.8em; }
</style>

<script>
  /* The preview shows only the next-48-hours chart of /co2-forecast/; the frame is fitted to its height. */
  (function () {
    var frame = document.getElementById('co2-preview');
    if (!frame) return;
    function fit() {
      try {
        var doc = frame.contentDocument;
        if (!doc || !doc.documentElement) return;
        var h = Math.ceil(doc.documentElement.getBoundingClientRect().height);
        if (h > 0 && Math.abs(frame.offsetHeight - h) > 2) frame.style.height = h + 'px';
      } catch (e) {}
    }
    frame.addEventListener('load', function () {
      fit();
      [200, 1000, 2500].forEach(function (ms) { setTimeout(fit, ms); });
      try { if (window.ResizeObserver) new ResizeObserver(fit).observe(frame.contentDocument.body); } catch (e) {}
    });
  })();
</script>
