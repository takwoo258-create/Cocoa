import '../core/json_utils.dart';

class PlazaMeta {
  const PlazaMeta({
    this.ok = false,
    this.shareId = '',
    this.globalUrl = '',
    this.globalAvailable = false,
    this.globalWritable = false,
    this.globalHost = '',
    this.rateLimit = 0,
    this.kinds = const <String>[],
    this.visibilities = const <String>[],
  });

  final bool ok;
  final String shareId;
  final String globalUrl;
  final bool globalAvailable;
  final bool globalWritable;
  final String globalHost;
  final int rateLimit;
  final List<String> kinds;
  final List<String> visibilities;

  factory PlazaMeta.fromJson(Map<String, dynamic> j) => PlazaMeta(
        ok: asBool(j['ok']),
        shareId: asString(j['shareId']),
        globalUrl: asString(j['globalUrl']),
        globalAvailable: asBool(j['globalAvailable']),
        globalWritable: asBool(j['globalWritable']),
        globalHost: asString(j['globalHost']),
        rateLimit: asInt(j['rateLimit']),
        kinds: asStringList(j['kinds']),
        visibilities: asStringList(j['visibilities']),
      );
}

class PlazaResource {
  const PlazaResource({
    required this.id,
    required this.kind,
    this.title = '',
    this.description = '',
    this.visibility = 'server',
    this.targetShareIds = const <String>[],
    this.ownerShareId = '',
    this.ownerNickname = '',
    this.ownerCode = 0,
    this.tokenSoft = 0,
    this.tokenHard = 0,
    this.permanent = false,
    this.startsAt = '',
    this.expiresAt = '',
    this.status = '',
    this.likeCount = 0,
    this.useCount = 0,
    this.liked = false,
    this.mine = false,
    this.visible = true,
    this.createdAt = '',
    this.updatedAt = '',
    this.services = const <String>[],
    this.preview = const <String, dynamic>{},
    this.grant = const <String, dynamic>{},
  });

  final String id;
  final String kind;
  final String title;
  final String description;
  final String visibility;
  final List<String> targetShareIds;
  final String ownerShareId;
  final String ownerNickname;
  final int ownerCode;
  final int tokenSoft;
  final int tokenHard;
  final bool permanent;
  final String startsAt;
  final String expiresAt;
  final String status;
  final int likeCount;
  final int useCount;
  final bool liked;
  final bool mine;
  final bool visible;
  final String createdAt;
  final String updatedAt;
  final List<String> services;
  final Map<String, dynamic> preview;
  final Map<String, dynamic> grant;

  bool get isTemplate => kind == 'template';
  bool get isModel => kind == 'model';

  factory PlazaResource.fromJson(Map<String, dynamic> j) {
    final Map<String, dynamic> owner = asMap(j['owner']);
    return PlazaResource(
      id: asString(j['id']),
      kind: asString(j['kind'], 'template'),
      title: asString(j['title']),
      description: asString(j['description']),
      visibility: asString(j['visibility'], 'server'),
      targetShareIds: asStringList(j['targetShareIds']),
      ownerShareId: asString(owner['shareId']),
      ownerNickname: asString(owner['nickname']),
      ownerCode: asInt(owner['code']),
      tokenSoft: asInt(j['tokenSoft']),
      tokenHard: asInt(j['tokenHard']),
      permanent: asBool(j['permanent']),
      startsAt: asString(j['startsAt']),
      expiresAt: asString(j['expiresAt']),
      status: asString(j['status']),
      likeCount: asInt(j['likeCount']),
      useCount: asInt(j['useCount']),
      liked: asBool(j['liked']),
      mine: asBool(j['mine']),
      visible: asBool(j['visible'], true),
      createdAt: asString(j['createdAt']),
      updatedAt: asString(j['updatedAt']),
      services: asStringList(j['services']),
      preview: asMap(j['preview']),
      grant: asMap(j['grant']),
    );
  }
}

class PlazaListResult {
  const PlazaListResult({this.items = const <PlazaResource>[], this.total = 0, this.ok = true});
  final List<PlazaResource> items;
  final int total;
  final bool ok;

  factory PlazaListResult.fromJson(Map<String, dynamic> j) => PlazaListResult(
        items: asMapList(j['items']).map(PlazaResource.fromJson).toList(),
        total: asInt(j['total']),
        ok: asBool(j['ok'], true),
      );
}

class PlazaLegacyShare {
  const PlazaLegacyShare({required this.id, this.title = '', this.jumpTo = '', this.data = const <String, dynamic>{}});
  final String id;
  final String title;
  final String jumpTo;
  final Map<String, dynamic> data;

  factory PlazaLegacyShare.fromJson(Map<String, dynamic> j) => PlazaLegacyShare(
        id: asString(j['id']),
        title: asString(j['title'], asString(j['name'])),
        jumpTo: asString(j['jumpTo']),
        data: j,
      );
}
