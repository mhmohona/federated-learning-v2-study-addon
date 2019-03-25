/* global FRECENCY_PREFS */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "(FrecencyOptimizer)" }]*/

class FrecencyOptimizer {
  static async svmLoss(urls, correct) {
    const frecencies = await FrecencyOptimizer.urlsToFrecencies(urls);
    const correctFrecency = frecencies[correct];

    let loss = 0;

    for (const frecency of frecencies) {
      if (frecency > correctFrecency) {
        loss += frecency - correctFrecency;
      }
    }

    return loss;
  }

  static async urlsToFrecencies(urls) {
    return Promise.all(
      urls.map(url => browser.experiments.frecency.calculateByURL(url)),
    );
  }

  constructor(synchronizer, lossFn, eps = 1) {
    this.synchronizer = synchronizer;
    this.lossFn = lossFn;
    this.eps = eps;
  }

  async step(
    numSuggestionsDisplayed,
    rankSelected,
    bookmarkAndHistoryUrlSuggestions,
    bookmarkAndHistoryRankSelected,
    numKeyDownEventsAtSelectedsFirstEntry,
    numKeyDownEvents,
    timeStartInteraction,
    timeEndInteraction,
    timeAtSelectedsFirstEntry,
    searchStringLength,
    selectedStyle,
    selectedUrlWasSameAsSearchString,
    enterWasPressed,
  ) {
    await browser.study.logger.debug([
      "frecencyOptimizer.step entered",
      {
        numSuggestionsDisplayed,
        rankSelected,
        bookmarkAndHistoryUrlSuggestions,
        bookmarkAndHistoryRankSelected,
        numKeyDownEvents,
        searchStringLength,
        selectedStyle,
      },
    ]);
    try {
      const frecencyScores = await FrecencyOptimizer.urlsToFrecencies(
        bookmarkAndHistoryUrlSuggestions,
      );
      const loss = await this.lossFn(
        bookmarkAndHistoryUrlSuggestions,
        bookmarkAndHistoryRankSelected,
      );
      const weights = await this.computeGradient(
        bookmarkAndHistoryUrlSuggestions,
        bookmarkAndHistoryRankSelected,
      );
      return this.synchronizer.onLocalModelUpdate({
        frecencyScores,
        loss,
        weights,
        numSuggestionsDisplayed,
        rankSelected,
        bookmarkAndHistoryNumSuggestionsDisplayed:
          bookmarkAndHistoryUrlSuggestions.length,
        bookmarkAndHistoryRankSelected,
        numKeyDownEventsAtSelectedsFirstEntry,
        numKeyDownEvents,
        timeStartInteraction,
        timeEndInteraction,
        timeAtSelectedsFirstEntry,
        searchStringLength,
        selectedStyle,
        selectedUrlWasSameAsSearchString,
        enterWasPressed,
      });
    } catch (error) {
      // Surfacing otherwise silent errors
      // eslint-disable-next-line no-console
      console.error(error.toString(), error.stack);
      throw new Error(error.toString());
    }
  }

  async computeGradient(
    bookmarkAndHistoryUrlSuggestions,
    bookmarkAndHistoryRankSelected,
  ) {
    const gradient = [];

    for (const pref of FRECENCY_PREFS) {
      const currentValue = await browser.frecencyPrefs.getIntPref(pref);

      await browser.frecencyPrefs.setIntPref(pref, currentValue - this.eps);
      const loss1 = await this.lossFn(
        bookmarkAndHistoryUrlSuggestions,
        bookmarkAndHistoryRankSelected,
      );

      await browser.frecencyPrefs.setIntPref(pref, currentValue + this.eps);
      const loss2 = await this.lossFn(
        bookmarkAndHistoryUrlSuggestions,
        bookmarkAndHistoryRankSelected,
      );

      const finiteDifference = (loss1 - loss2) / (2 * this.eps);
      gradient.push(finiteDifference);

      await browser.frecencyPrefs.setIntPref(pref, currentValue);
    }

    return gradient;
  }
}
