import { UnreachableCode } from '../../../../resources/not_reached';
import Util from '../../../../resources/util';
import { LooseTrigger } from '../../../../types/trigger';
import raidbossFileData from '../../data/raidboss_manifest.txt';
import { PopupTextGenerator, TriggerHelper } from '../../popup-text';
import { RaidbossOptions } from '../../raidboss_options';
import { TimelineLoader } from '../../timeline';
import EmulatorCommon, { DataType } from '../EmulatorCommon';
import EventBus from '../EventBus';
import RaidEmulatorAnalysisTimelineUI from '../overrides/RaidEmulatorAnalysisTimelineUI';
import RaidEmulatorPopupText from '../overrides/RaidEmulatorPopupText';
import RaidEmulatorTimelineController from '../overrides/RaidEmulatorTimelineController';
import RaidEmulatorWatchCombatantsOverride from '../overrides/RaidEmulatorWatchCombatantsOverride';

import Combatant from './Combatant';
import Encounter from './Encounter';
import LineEvent from './network_log_converter/LineEvent';
import PopupTextAnalysis, { LineRegExpCache, Resolver, ResolverStatus } from './PopupTextAnalysis';
import RaidEmulator from './RaidEmulator';

export type PerspectiveTrigger = {
  triggerHelper: TriggerHelper;
  status: ResolverStatus;
  logLine: LineEvent;
  resolvedOffset: number;
};
type Perspective = {
  initialData: DataType;
  triggers: PerspectiveTrigger[];
  finalData?: DataType;
};
type Perspectives = { [id: string]: Perspective };

export default class AnalyzedEncounter extends EventBus {
  perspectives: Perspectives = {};
  regexCache: LineRegExpCache | undefined;
  constructor(
    public options: RaidbossOptions,
    public encounter: Encounter,
    public emulator: RaidEmulator,
    public watchCombatantsOverride: RaidEmulatorWatchCombatantsOverride,
  ) {
    super();
  }

  selectPerspective(id: string, popupText: PopupTextAnalysis | RaidEmulatorPopupText): void {
    if (this.encounter && this.encounter.combatantTracker) {
      const selectedPartyMember = this.encounter.combatantTracker.combatants[id];
      if (!selectedPartyMember)
        return;

      popupText?.getPartyTracker().onPartyChanged({
        party: this.encounter.combatantTracker.partyMembers.map((id) => {
          const partyMember = this.encounter?.combatantTracker?.combatants[id];
          if (!partyMember)
            throw new UnreachableCode();
          return {
            id: id,
            worldId: 0,
            name: partyMember.name,
            job: Util.jobToJobEnum(partyMember.job ?? 'NONE'),
            inParty: true,
          };
        }),
      });
      this.updateState(selectedPartyMember, this.encounter.startTimestamp, popupText);
      popupText?.OnChangeZone({
        type: 'ChangeZone',
        zoneName: this.encounter.encounterZoneName,
        zoneID: parseInt(this.encounter.encounterZoneId, 16),
      });
    }
  }

  updateState(
    combatant: Combatant,
    timestamp: number,
    popupText: PopupTextAnalysis | RaidEmulatorPopupText,
  ): void {
    const job = combatant.job;
    if (!job)
      throw new UnreachableCode();
    const state = combatant.getState(timestamp);
    popupText?.OnPlayerChange({
      detail: {
        id: parseInt(combatant.id),
        name: combatant.name,
        job: job,
        level: combatant.level ?? 0,
        currentHP: state.hp,
        maxHP: state.maxHp,
        currentMP: state.mp,
        maxMP: state.maxMp,
        currentCP: 0,
        maxCP: 0,
        currentGP: 0,
        maxGP: 0,
        currentShield: 0,
        jobDetail: null,
        pos: {
          x: state.posX,
          y: state.posY,
          z: state.posZ,
        },
        rotation: state.heading,
        bait: 0,
        debugJob: '',
      },
    });
  }

  async analyze(): Promise<void> {
    // @TODO: Make this run in parallel sometime in the future, since it could be really slow?
    if (this.encounter.combatantTracker) {
      for (const id of this.encounter.combatantTracker.partyMembers)
        await this.analyzeFor(id);
    }

    // Free up this memory
    delete this.regexCache;

    return this.dispatch('analyzed');
  }

  async analyzeFor(id: string): Promise<void> {
    if (!this.encounter.combatantTracker)
      return;
    let currentLogIndex = 0;
    const partyMember = this.encounter.combatantTracker.combatants[id];

    const getCurLogLine = (): LineEvent => {
      const line = this.encounter.logLines[currentLogIndex];
      if (!line)
        throw new UnreachableCode();
      return line;
    };

    if (!partyMember)
      return;

    if (!partyMember.job) {
      this.perspectives[id] = {
        initialData: {},
        triggers: [],
      };
      return;
    }

    const timelineUI = new RaidEmulatorAnalysisTimelineUI(this.options);
    const timelineController = new RaidEmulatorTimelineController(
      this.options,
      timelineUI,
      raidbossFileData,
    );
    timelineController.bindTo(this.emulator);

    const popupText = new PopupTextAnalysis(
      this.options,
      new TimelineLoader(timelineController),
      raidbossFileData,
    );

    if (this.regexCache)
      popupText.regexCache = this.regexCache;

    const generator = new PopupTextGenerator(popupText);
    timelineUI.SetPopupTextInterface(generator);

    timelineController.SetPopupTextInterface(generator);

    this.selectPerspective(id, popupText);

    if (timelineController.activeTimeline?.ui) {
      timelineController.activeTimeline.ui.OnTrigger = (trigger: LooseTrigger, matches) => {
        const currentLine = this.encounter.logLines[currentLogIndex];
        if (!currentLine)
          throw new UnreachableCode();

        const resolver = popupText.currentResolver = new Resolver({
          initialData: EmulatorCommon.cloneData(popupText.getData()),
          suppressed: false,
          executed: false,
        });
        resolver.triggerHelper = popupText._onTriggerInternalGetHelper(
          trigger,
          matches?.groups ?? {},
          currentLine?.timestamp,
        );
        popupText.triggerResolvers.push(resolver);

        if (!currentLine)
          throw new UnreachableCode();

        popupText.OnTrigger(trigger, matches, currentLine.timestamp);

        resolver.setFinal(() => {
          // Get the current log line when the callback is executed instead of the line
          // when the trigger initially fires
          const resolvedLine = getCurLogLine();
          resolver.status.finalData = EmulatorCommon.cloneData(popupText.getData());
          delete resolver.triggerHelper?.resolver;
          if (popupText.callback) {
            popupText.callback(
              resolvedLine,
              resolver.triggerHelper,
              resolver.status,
              popupText.getData(),
            );
          }
        });
      };
    }

    popupText.callback = (log, triggerHelper, currentTriggerStatus) => {
      const perspective = this.perspectives[id];
      if (!perspective || !triggerHelper)
        throw new UnreachableCode();

      const delay = currentTriggerStatus.delay ?? 0;

      perspective.triggers.push({
        triggerHelper: triggerHelper,
        status: currentTriggerStatus,
        logLine: log,
        resolvedOffset: (log.timestamp - this.encounter.startTimestamp) +
          (delay * 1000),
      });
    };
    popupText.triggerResolvers = [];

    this.perspectives[id] = {
      initialData: EmulatorCommon.cloneData(popupText.getData(), []),
      triggers: [],
      finalData: popupText.getData(),
    };

    for (; currentLogIndex < this.encounter.logLines.length; ++currentLogIndex) {
      const log = this.encounter.logLines[currentLogIndex];
      if (!log)
        throw new UnreachableCode();
      await this.dispatch('analyzeLine', log);

      const combatant = this.encounter?.combatantTracker?.combatants[id];

      if (combatant && combatant.hasState(log.timestamp))
        this.updateState(combatant, log.timestamp, popupText);

      this.watchCombatantsOverride.tick(log.timestamp);
      await popupText.onEmulatorLog([log], getCurLogLine);
      timelineController.onEmulatorLogEvent([log]);
    }

    this.watchCombatantsOverride.clear();
    timelineUI.stop();
    this.regexCache = popupText.regexCache;
  }
}
