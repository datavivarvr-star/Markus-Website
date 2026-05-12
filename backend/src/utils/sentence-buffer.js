const SENTENCE_END = /([.!?]+)(\s|$)/;

export function createSentenceBuffer(onSentence) {
  let buf = '';
  return {
    push(token) {
      if (!token) return;
      buf += token;
      let m;
      while ((m = SENTENCE_END.exec(buf))) {
        const end = m.index + m[1].length;
        const sentence = buf.slice(0, end).trim();
        buf = buf.slice(end).replace(/^\s+/, '');
        if (sentence) onSentence(sentence);
      }
    },
    flush() {
      const rest = buf.trim();
      buf = '';
      if (rest) onSentence(rest);
    },
  };
}
