'use strict';

const PANEL_PATH = 'sidepanel.html';

async function openPanel(tab) {
  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    try {
      await chrome.sidePanel.open({ windowId: tab && tab.windowId });
      return;
    } catch (error) {
      console.warn('Side Panel API недоступен, открываю отдельную вкладку:', error);
    }
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
}

chrome.action.onClicked.addListener((tab) => {
  openPanel(tab).catch((error) => console.error('Не удалось открыть расширение:', error));
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setOptions === 'function') {
    chrome.sidePanel.setOptions({ path: PANEL_PATH, enabled: true }).catch(() => {});
  }
});
