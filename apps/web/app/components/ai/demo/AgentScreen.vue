<script setup lang="ts">
/**
 * Gallery demo for AiAgentScreen: the default variant (with and without a live source) and
 * the Loading variant.
 *
 * The source has no scripted timeline for this component (no setTimeout stages) - opening the
 * viewer, teaching a task and collapsing are all direct interactions - so there is no
 * "Rejouer" button here, unlike the demos that replay a story. Hover the resting card to
 * reveal "Ouvrir", open it, click "Apprendre une tâche" to start recording, collapse (the
 * corners-in button) to see the REC badge on the resting card while recording keeps going,
 * reopen and click "Terminer" to stop.
 *
 * The snapshot below is a self-contained data URI (a warm, stylised room), not a network
 * fetch: demos must not call the hub or load outside resources the source itself does not
 * load, and the source's own placeholder image is not available to reuse here either.
 */

const CAMERA_SNAPSHOT =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#3a3f4b" /><stop offset="100%" stop-color="#1c1f26" /></linearGradient></defs>' +
      '<rect width="320" height="200" fill="url(#g)" />' +
      '<rect x="30" y="24" width="80" height="56" rx="4" fill="#f2c879" opacity="0.85" />' +
      '<circle cx="150" cy="46" r="10" fill="#f2c879" opacity="0.5" />' +
      '<rect x="170" y="90" width="120" height="40" rx="12" fill="#6b5847" />' +
      '<rect x="176" y="80" width="30" height="22" rx="9" fill="#6b5847" />' +
      '<rect x="254" y="80" width="30" height="22" rx="9" fill="#6b5847" />' +
      '</svg>'
  )

const openA = ref(false)
const recordingA = ref(false)
const startedAtA = ref<number | undefined>(undefined)
function onRecordA() {
  recordingA.value = true
  startedAtA.value = Date.now()
}
function onStopA() {
  recordingA.value = false
  startedAtA.value = undefined
}

const openB = ref(false)
const recordingB = ref(false)
const startedAtB = ref<number | undefined>(undefined)
function onRecordB() {
  recordingB.value = true
  startedAtB.value = Date.now()
}
function onStopB() {
  recordingB.value = false
  startedAtB.value = undefined
}
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Par défaut</p>
      <div class="bg-canvas rounded-window flex flex-wrap gap-6 p-6">
        <AiAgentScreen
          v-model:open="openA"
          :src="CAMERA_SNAPSHOT"
          title="Caméra entrée"
          live
          :recording="recordingA"
          :started-at="startedAtA"
          @record="onRecordA"
          @stop="onStopA"
        />
        <AiAgentScreen
          v-model:open="openB"
          title="Caméra bureau (hors ligne)"
          :recording="recordingB"
          :started-at="startedAtB"
          @record="onRecordB"
          @stop="onStopB"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Chargement</p>
      <div class="bg-canvas rounded-window p-6">
        <AiAgentScreen variant="Loading" title="Caméra salon" />
      </div>
    </div>
  </section>
</template>
