const { createApp } = Vue;

const PERSONAS = [
  {
    id: 'listener', name: '温柔倾听者', emoji: '🌷',
    prompt: '你是一个温柔、耐心的情感陪伴者。你的首要任务不是给建议，而是先倾听、共情、接纳对方的情绪。用平和温暖的语气回应，适当用轻声的追问让对方愿意多说。不要说教，不要急着解决问题。像深夜陪朋友聊天那样自然、真诚、简短。',
  },
  {
    id: 'cheer', name: '元气鼓励师', emoji: '⚡',
    prompt: '你是一个充满元气与正能量的陪伴者。你用轻松活泼、鼓励的语气陪伴对方，在对方低落时给予温暖支持和恰到好处的打气，但拒绝空洞鸡汤。像最好的朋友一样自然、真实、有力量。',
  },
  {
    id: 'rational', name: '理性树洞', emoji: '🧭',
    prompt: '你是一个理性、沉稳的倾听者。你先共情对方的情绪，再温和地帮对方梳理事情脉络，提供清晰、务实的视角与可行的下一步。不评判、不武断，让对方自己看清。',
  },
  {
    id: 'bestie', name: '知心伙伴', emoji: '🤝',
    prompt: '你像一个可靠又贴心的知心伙伴，既能温柔接住对方的情绪，也能在合适的时候给出真诚、不敷衍的建议。语气自然、平等、不说教，像认识很久的老朋友。',
  },
  { id: 'custom', name: '自定义', emoji: '✍️', prompt: '' },
];

const STORE_KEY = 'warmisle.v1';

createApp({
  data() {
    return {
      personas: PERSONAS,
      moods: ['开心', '平静', '焦虑', '难过', '疲惫', '委屈', '愤怒', '迷茫'],
      providers: [],
      provider: 'doubao',
      model: 'doubao-seed-mini-250615',
      apiKey: '',
      temperature: 0.85,
      persona: 'listener',
      customPrompt: '',
      mood: '',
      messages: [],
      inputText: '',
      sending: false,
      errorMsg: '',
      sidebarOpen: false,
    };
  },
  computed: {
    needKey() {
      const p = this.providers.find((x) => x.id === this.provider);
      return !!(p && p.needKey);
    },
    providerHint() {
      const p = this.providers.find((x) => x.id === this.provider);
      return p ? p.hint : '';
    },
    modelOptions() {
      const p = this.providers.find((x) => x.id === this.provider);
      return p ? p.models : [];
    },
    providerHasDefault() {
      const p = this.providers.find((x) => x.id === this.provider);
      return !!(p && p.hasDefault);
    },
    usingSiteKey() {
      return this.needKey && !this.apiKey.trim() && this.providerHasDefault;
    },
    keyHint() {
      if (!this.needKey) return '';
      return this.providerHasDefault
        ? '留空将自动使用站点默认免费额度'
        : '该服务商暂未配置默认 Key，需填写你自己的';
    },
    currentPersonaName() {
      const p = this.personas.find((x) => x.id === this.persona);
      return p ? p.name : '自定义';
    },
    currentSystemPrompt() {
      let base;
      if (this.persona === 'custom') base = this.customPrompt || '你是一个善解人意的情感陪伴者。';
      else base = (this.personas.find((x) => x.id === this.persona) || {}).prompt || '';
      let extra = '\n\n回应原则：像真人聊天一样自然，长度适中，重陪伴轻说教。';
      if (this.mood) extra += `\n当前用户自述心情：${this.mood}，请在回应中照顾到这一点。`;
      return base + extra;
    },
  },
  watch: {
    provider() { this.persist(); },
    model() { this.persist(); },
    apiKey() { this.persist(); },
    persona() { this.persist(); },
    customPrompt() { this.persist(); },
    temperature() { this.persist(); },
  },
  methods: {
    async fetchModels() {
      try {
        const r = await fetch('/api/models');
        const d = await r.json();
        this.providers = d.providers;
        if (!this.modelOptions.includes(this.model)) this.model = this.modelOptions[0];
      } catch (e) {
        this.errorMsg = '无法获取模型列表';
      }
    },
    onProviderChange() {
      if (this.modelOptions.length) this.model = this.modelOptions[0];
    },
    loadState() {
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        if (s.messages) this.messages = s.messages;
        if (s.provider) this.provider = s.provider;
        if (s.model) this.model = s.model;
        if (s.apiKey) this.apiKey = s.apiKey;
        if (typeof s.temperature === 'number') this.temperature = s.temperature;
        if (s.persona) this.persona = s.persona;
        if (s.customPrompt) this.customPrompt = s.customPrompt;
        if (s.mood) this.mood = s.mood;
      } catch (_) {}
    },
    persist() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          messages: this.messages, provider: this.provider, model: this.model,
          apiKey: this.apiKey, temperature: this.temperature,
          persona: this.persona, customPrompt: this.customPrompt, mood: this.mood,
        }));
      } catch (_) {}
    },
    saveHistory() { this.persist(); },
    clearChat() {
      if (!confirm('确定清空当前对话？')) return;
      this.messages = [];
      this.persist();
    },
    scrollBottom() {
      this.$nextTick(() => {
        const box = this.$refs.msgBox;
        if (box) box.scrollTop = box.scrollHeight;
      });
    },
    async sendMessage() {
      const text = this.inputText.trim();
      if (!text || this.sending) return;
      if (this.needKey && !this.apiKey.trim() && !this.providerHasDefault) {
        this.errorMsg = '该服务商暂未配置默认 Key，请在左侧填入你自己的 API Key';
        return;
      }
      this.messages.push({ role: 'user', content: text });
      this.inputText = '';
      this.errorMsg = '';
      this.persist();
      this.scrollBottom();

      const history = this.messages.slice();
      const payload = {
        provider: this.provider,
        model: this.model,
        apiKey: this.apiKey,
        temperature: this.temperature,
        messages: [{ role: 'system', content: this.currentSystemPrompt }, ...history],
      };

      const aiMsg = { role: 'assistant', content: '' };
      this.messages.push(aiMsg);
      this.sending = true;

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}));
          throw new Error(e.error || ('HTTP ' + resp.status));
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const j = JSON.parse(data);
              if (j.delta) { aiMsg.content += j.delta; this.scrollBottom(); }
              if (j.error) this.errorMsg = j.error;
            } catch (_) {}
          }
        }
        if (!aiMsg.content) aiMsg.content = '（没有收到内容，可能是模型未就绪或密钥无效）';
      } catch (e) {
        this.errorMsg = e.message || String(e);
        if (!aiMsg.content) this.messages.pop();
      } finally {
        this.sending = false;
        this.persist();
      }
    },
  },
  mounted() {
    this.loadState();
    this.fetchModels();
  },
}).mount('#app');
