const store = {};

export function getUserState(from) {
  if (!store[from]) {
    store[from] = { history: [], fase_ciclo: '', energia: '', sueno_h: '', agua_ml: 0 };
  }
  return store[from];
}

export function setUserState(from, state) {
  store[from] = state;
}

function scheduleDailyReset() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  setTimeout(() => {
    Object.keys(store).forEach(key => {
      store[key] = { history: [], fase_ciclo: store[key].fase_ciclo || '', energia: '', sueno_h: '', agua_ml: 0 };
    });
    scheduleDailyReset();
  }, next - now);
}

scheduleDailyReset();
