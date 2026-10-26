import { SCHEMA_DRIFT_MESSAGE } from '../platform/schema';
import { Body, Heading, Notice, Screen } from './kit';

export function Booting() {
  return (
    <Screen>
      <p role="status" className="text-base text-ih-fg-2">
        Opening InspectorHub
      </p>
    </Screen>
  );
}

/** The database on this device was written by a newer app. Opening it with this one could damage it. */
export function SchemaTooNew() {
  return (
    <Screen>
      <Heading>This app is older than your data</Heading>
      <Body>The data on this device was saved by a newer version of InspectorHub. Update the app to open it. Nothing has been changed or deleted.</Body>
      <Notice tone="info">Exporting the data from this device is not available yet.</Notice>
    </Screen>
  );
}

/** A development device installed an earlier build of the local database. Not reachable on a device that never had one. */
export function SchemaDrift() {
  return (
    <Screen>
      <Heading>Local database is out of date</Heading>
      <Body>{SCHEMA_DRIFT_MESSAGE}</Body>
    </Screen>
  );
}

export function OpenFailed() {
  return (
    <Screen>
      <Heading>InspectorHub could not open</Heading>
      <Body>The app could not open its storage on this device. Close the app and open it again. Your data has not been changed.</Body>
    </Screen>
  );
}
