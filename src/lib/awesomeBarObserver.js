/* global FrecencyOptimizer */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "(svmLoss|AwesomeBarObserver)" }]*/

class AwesomeBarObserver {
  constructor(synchronizer) {
    this.frecencyOptimizer = new FrecencyOptimizer(
      synchronizer,
      FrecencyOptimizer.svmLoss,
    );
    this.eventsToObserve = [
      "onFocus",
      "onBlur",
      "onKeyDown",
      "onKeyPress",
      "onInput",
      "onAutocompleteSuggestionsHidden",
      "onAutocompleteSuggestionsUpdated",
      "onAutocompleteSuggestionSelected",
    ];
    this.observedEventsSinceLastFocus = [];
  }
  async start() {
    this.eventsToObserve.map(eventRef => {
      browser.experiments.awesomeBar[eventRef].addListener(
        this[eventRef].bind(this),
      );
    });
    await browser.experiments.awesomeBar.start();
  }

  async stop() {
    await browser.experiments.awesomeBar.stop();
    this.eventsToObserve.map(eventRef => {
      browser.experiments.awesomeBar[eventRef].removeListener(this[eventRef]);
    });
  }

  /**
   * Three main interactions with the awesome bar trigger a model update via study telemetry:
   * 1. A suggestion was selected from the autocomplete popup
   * 2. The autocomplete popup got some suggestions displayed but none were selected
   * 3. The autocomplete popup did not get some suggestions displayed and none was selected
   * @returns {Promise<boolean>} Promise that resolves when the method has completed
   */
  async afterInteraction() {
    await browser.study.logger.debug([
      "awesomeBarObserver.afterInteraction entered",
      {
        observedEventsSinceLastFocus: this.observedEventsSinceLastFocus,
      },
    ]);

    try {
      const focusEvent = this.observedEventsSinceLastFocus
        .slice()
        .reverse()
        .find(observedEvent => {
          return (
            observedEvent.awesomeBarState && observedEvent.type === "onFocus"
          );
        });

      // Drop interactions where we did not catch the focus event (happens at browser startup
      // and if the study is enabled while an interaction is ongoing)
      if (!focusEvent) {
        await browser.study.logger.debug(
          "Dropping awesome bar interaction metadata since no onFocus event was captured",
        );
        return false;
      }

      await this.updateModel(focusEvent);
      await this.fireMidStudySurveyIfRelevant();
    } catch (error) {
      // Surfacing otherwise silent errors
      // eslint-disable-next-line no-console
      console.error(error.toString(), error.stack);
      throw new Error(error.toString());
    }
    return true;
  }

  /**
   * @returns {Promise<boolean>} Promise that resolves when the method has completed
   */
  async fireMidStudySurveyIfRelevant() {
    const { midStudySurveyPeriodStarted } = await browser.storage.local.get(
      "midStudySurveyPeriodStarted",
    );
    if (!midStudySurveyPeriodStarted) {
      return false;
    }

    const { midStudySurveyFired } = await browser.storage.local.get(
      "midStudySurveyFired",
    );
    if (midStudySurveyFired) {
      return false;
    }

    const {
      previousInteractionsWithinMidStudySurveyPeriod,
    } = await browser.storage.local.get(
      "previousInteractionsWithinMidStudySurveyPeriod",
    );
    const interactionsWithinMidStudySurveyPeriod =
      (previousInteractionsWithinMidStudySurveyPeriod
        ? previousInteractionsWithinMidStudySurveyPeriod
        : 0) + 1;
    await browser.study.logger.log(
      `Awesome bar interactions within the mid-study survey period: ${interactionsWithinMidStudySurveyPeriod}`,
    );
    if (interactionsWithinMidStudySurveyPeriod === 2) {
      await browser.study.logger.log("Firing mid-study survey in 5 seconds");
      await browser.storage.local.set({ midStudySurveyFired: true });
      setTimeout(async() => {
        await browser.study.logger.log("Firing mid-study survey");
        // Fire mid-study survey after 5 seconds
        const url = await browser.study.fullSurveyUrl(
          "https://qsurvey.mozilla.com/s3/URL-bar-satisfaction-survey/",
          "mid-study-survey",
        );
        await browser.tabs.create({ url });
      }, 5000);
    } else {
      await browser.storage.local.set({
        previousInteractionsWithinMidStudySurveyPeriod: interactionsWithinMidStudySurveyPeriod,
      });
    }
    return true;
  }

  /**
   * @param {object} focusEvent Already extracted to check for interaction validity, thus forwarded here as an argument
   * @returns {Promise<boolean>} Promise that resolves when the method has completed
   */
  async updateModel(focusEvent) {
    const blurEvent = this.observedEventsSinceLastFocus
      .slice()
      .reverse()
      .find(observedEvent => {
        return observedEvent.awesomeBarState && observedEvent.type === "onBlur";
      });

    // Timings are normalized relative to the start of the interaction
    const timeStartInteraction = 0;
    const timeEndInteraction =
      blurEvent.timestamp.getTime() - focusEvent.timestamp.getTime();

    const selectionEvent = this.observedEventsSinceLastFocus
      .slice()
      .reverse()
      .find(observedEvent => {
        return (
          observedEvent.awesomeBarState &&
          observedEvent.type === "onAutocompleteSuggestionSelected"
        );
      });

    const enterKeyPressEvents = this.observedEventsSinceLastFocus.filter(
      observedEvent => {
        return (
          observedEvent.type === "onKeyPress" &&
          observedEvent.keyEvent &&
          observedEvent.keyEvent.key === "Enter"
        );
      },
    );
    const enterWasPressed = enterKeyPressEvents.length > 0 ? 1 : 0;

    // 1. A suggestion was selected from the autocomplete popup
    if (selectionEvent) {
      const {
        rankSelected,
        searchString,
        searchStringLength,
        numSuggestionsDisplayed,
        suggestions,
      } = selectionEvent.awesomeBarState;

      const numKeyDownEvents = AwesomeBarObserver.numKeyDownEvents(
        this.observedEventsSinceLastFocus,
      );

      const selectedSuggestion = suggestions[rankSelected];

      const selectedUrlWasSameAsSearchString = AwesomeBarObserver.selectedUrlWasSameAsSearchString(
        searchString,
        selectedSuggestion.url,
      );

      const bookmarkAndHistorySuggestions = suggestions.filter(suggestion =>
        AwesomeBarObserver.isBookmarkOrHistoryStyle(suggestion.style),
      );
      const bookmarkAndHistoryUrlSuggestions = bookmarkAndHistorySuggestions.map(
        suggestion => suggestion.url,
      );
      const bookmarkAndHistoryRankSelected = bookmarkAndHistoryUrlSuggestions.indexOf(
        selectedSuggestion.url,
      );
      const selectedStyle = selectedSuggestion.style;

      const eventsAtSelectedsFirstEntry = AwesomeBarObserver.eventsAtSelectedsFirstEntry(
        this.observedEventsSinceLastFocus,
      );
      const numKeyDownEventsAtSelectedsFirstEntry = AwesomeBarObserver.numKeyDownEvents(
        eventsAtSelectedsFirstEntry,
      );
      const eventAtSelectedsFirstEntry = eventsAtSelectedsFirstEntry
        .slice()
        .pop();
      const timeAtSelectedsFirstEntry =
        eventAtSelectedsFirstEntry.timestamp.getTime() -
        focusEvent.timestamp.getTime();

      await this.frecencyOptimizer.step(
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
      );
    } else {
      // Find awesomeBarState at latest search result update if any
      const latestUpdateEvent = this.observedEventsSinceLastFocus
        .slice()
        .reverse()
        .find(observedEvent => {
          return (
            observedEvent.awesomeBarState &&
            observedEvent.type === "onAutocompleteSuggestionsUpdated"
          );
        });

      // 2. The autocomplete popup got some suggestions displayed but none were selected
      if (latestUpdateEvent) {
        const rankSelected = -1;

        const {
          searchStringLength,
          numSuggestionsDisplayed,
          suggestions,
        } = latestUpdateEvent.awesomeBarState;

        const numKeyDownEventsAtSelectedsFirstEntry = -1;
        const numKeyDownEvents = AwesomeBarObserver.numKeyDownEvents(
          this.observedEventsSinceLastFocus,
        );

        const bookmarkAndHistorySuggestions = suggestions.filter(suggestion =>
          AwesomeBarObserver.isBookmarkOrHistoryStyle(suggestion.style),
        );
        const bookmarkAndHistoryUrlSuggestions = bookmarkAndHistorySuggestions.map(
          suggestion => suggestion.url,
        );
        const bookmarkAndHistoryRankSelected = -1;
        const timeAtSelectedsFirstEntry = -1;
        const selectedStyle = "";
        const selectedUrlWasSameAsSearchString = -1;

        await this.frecencyOptimizer.step(
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
        );
      } else {
        // 3. The autocomplete popup did not get some suggestions displayed and none was selected

        const rankSelected = -1;

        const { searchStringLength } = focusEvent.awesomeBarState;

        const numKeyDownEventsAtSelectedsFirstEntry = -1;
        const numKeyDownEvents = AwesomeBarObserver.numKeyDownEvents(
          this.observedEventsSinceLastFocus,
        );

        const numSuggestionsDisplayed = 0;
        const bookmarkAndHistoryUrlSuggestions = [];
        const bookmarkAndHistoryRankSelected = -1;
        const timeAtSelectedsFirstEntry = -1;
        const selectedStyle = "";
        const selectedUrlWasSameAsSearchString = -1;

        await this.frecencyOptimizer.step(
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
        );
      }
    }
    return true;
  }

  async onFocus(awesomeBarState) {
    // Always reset on focus, since it marks the beginning of the awesome bar interaction
    this.observedEventsSinceLastFocus = [];
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      awesomeBarState,
      timestamp: new Date(),
      type: "onFocus",
    });
    return true;
  }

  async onBlur(awesomeBarState) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      awesomeBarState,
      timestamp: new Date(),
      type: "onBlur",
    });
    await this.afterInteraction();
    return true;
  }

  async onKeyDown(keyEvent) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      keyEvent,
      timestamp: new Date(),
      type: "onKeyDown",
    });
    return true;
  }

  async onKeyPress(keyEvent) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      keyEvent,
      timestamp: new Date(),
      type: "onKeyPress",
    });
    return true;
  }

  async onInput(awesomeBarState) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      awesomeBarState,
      timestamp: new Date(),
      type: "onInput",
    });
    return true;
  }

  async onAutocompleteSuggestionsHidden(awesomeBarState) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      awesomeBarState,
      timestamp: new Date(),
      type: "onAutocompleteSuggestionsHidden",
    });
    return true;
  }

  async onAutocompleteSuggestionsUpdated(awesomeBarState) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      awesomeBarState,
      timestamp: new Date(),
      type: "onAutocompleteSuggestionsUpdated",
    });
    return true;
  }

  async onAutocompleteSuggestionSelected(awesomeBarState) {
    if (await browser.privacyContext.aPrivateBrowserWindowIsOpen()) {
      // drop the event - do not do any model training
      return false;
    }
    this.observedEventsSinceLastFocus.push({
      awesomeBarState,
      timestamp: new Date(),
      type: "onAutocompleteSuggestionSelected",
    });
    return true;
  }

  static isBookmarkOrHistoryStyle(styleString) {
    const NON_BOOKMARK_OR_HISTORY_STYLES = [
      "switchtab",
      "remotetab",
      "searchengine",
      "visiturl",
      "extension",
      "suggestion",
      "keyword",
    ];
    const styles = new Set(styleString.split(/\s+/));
    const isNonBookmarkOrHistoryStyle = NON_BOOKMARK_OR_HISTORY_STYLES.some(s =>
      styles.has(s),
    );
    return !isNonBookmarkOrHistoryStyle;
  }

  /**
   * @param {string} searchString Self-explanatory hopefully
   * @param {object} selectedSuggestionUrl Self-explanatory hopefully
   * @returns {int} the amount of key down events since last focus, excluding "Enter" key down events
   */
  static selectedUrlWasSameAsSearchString(searchString, selectedSuggestionUrl) {
    const normalize = str => {
      if (str.indexOf("moz-action:visiturl") === 0) {
        const visitUrlMetadataJson = str.substr(
          "moz-action:visiturl".length + 1,
        );
        const visitUrlMetadata = JSON.parse(visitUrlMetadataJson);
        str = decodeURIComponent(visitUrlMetadata.url);
      }
      const withoutInitialProtocol = str.replace(/(^\w+:|^)\/\//, "");
      const withoutEndingSlash = withoutInitialProtocol.replace(/\/$/, "");
      const lowerCase = withoutEndingSlash.toLowerCase();
      return lowerCase;
    };
    return normalize(searchString) === normalize(selectedSuggestionUrl) ? 1 : 0;
  }

  /**
   * @param {array} observedEventsSinceLastFocus Self-explanatory hopefully
   * @returns {int} the amount of key down events since last focus, excluding "Enter" key down events
   */
  static numKeyDownEvents(observedEventsSinceLastFocus) {
    const keyDownEvents = observedEventsSinceLastFocus.filter(observedEvent => {
      return (
        observedEvent.type === "onKeyDown" &&
        observedEvent.keyEvent &&
        observedEvent.keyEvent.key !== "Enter"
      );
    });
    return keyDownEvents.length;
  }

  /**
   * @param {array} observedEventsSinceLastFocus Self-explanatory hopefully
   * @returns {int} The events up until and including the event at which the one that they ultimately selected entered the list
   */
  static eventsAtSelectedsFirstEntry(observedEventsSinceLastFocus) {
    const selectionEvent = observedEventsSinceLastFocus
      .slice()
      .reverse()
      .find(observedEvent => {
        return (
          observedEvent.awesomeBarState &&
          observedEvent.type === "onAutocompleteSuggestionSelected"
        );
      });

    if (!selectionEvent) {
      throw new Error("No selection event observed");
    }

    const selectedUrl =
      selectionEvent.awesomeBarState.suggestions[
        selectionEvent.awesomeBarState.rankSelected
      ].url;

    const eventWhereTheSelectedUrlAppearedForTheFirstTime = observedEventsSinceLastFocus.find(
      observedEvent => {
        return (
          observedEvent.awesomeBarState &&
          observedEvent.awesomeBarState.suggestions.find(
            suggestion => suggestion.url === selectedUrl,
          )
        );
      },
    );

    if (!eventWhereTheSelectedUrlAppearedForTheFirstTime) {
      throw new Error("No event with the selected url observed");
    }

    const index = observedEventsSinceLastFocus.indexOf(
      eventWhereTheSelectedUrlAppearedForTheFirstTime,
    );
    return observedEventsSinceLastFocus.slice(0, index + 1);
  }
}
