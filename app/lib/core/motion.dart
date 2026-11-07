
import 'app_state.dart';

/// v1.5.2：off=0，reduced=一半，normal=原时长。
Duration motionDuration(AppState state, Duration normal) {
  switch (state.motion) {
    case 'off':
      return Duration.zero;
    case 'reduced':
      return Duration(milliseconds: (normal.inMilliseconds / 2).round());
    default:
      return normal;
  }
}
